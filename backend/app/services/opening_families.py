from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime
from pathlib import Path

import chess
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.external_sync_state import ExternalSyncState
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.opening_family import OpeningFamily
from app.models.position import Position
from app.services.game_scope import time_class_condition
from app.services.master_openings import extract_san_moves, iter_opening_rows, opening_data_dir
from app.services.swr import stale_while_revalidate
from app.utils.fen import normalize_fen


def parse_family_segments(name: str) -> list[str]:
    family, separator, rest = name.partition(": ")
    segments = [family.strip()] if family.strip() else []
    if separator:
        segments.extend(part.strip() for part in rest.split(", ") if part.strip())
    return segments


def compute_root_fen(pgn: str) -> str:
    board = chess.Board()
    for san in extract_san_moves(pgn):
        board.push(board.parse_san(san))
    return normalize_fen(board.fen())


def _pgn_ply_count(pgn: str) -> int:
    return len(extract_san_moves(pgn))


FAMILIES_SEED_PROVIDER = "opening_families_seed"


async def _families_already_seeded(session: AsyncSession, fingerprint: str) -> bool:
    state = await session.get(ExternalSyncState, FAMILIES_SEED_PROVIDER)
    return state is not None and state.last_error == fingerprint


async def _mark_families_seeded(session: AsyncSession, fingerprint: str) -> None:
    state = await session.get(ExternalSyncState, FAMILIES_SEED_PROVIDER)
    if state is None:
        state = ExternalSyncState(provider=FAMILIES_SEED_PROVIDER)
        session.add(state)
    state.last_error = fingerprint
    state.updated_at = datetime.now(UTC)
    await session.flush()


async def seed_opening_families(
    session: AsyncSession,
    data_dir: Path | None = None,
) -> int:
    rows_by_name: dict[str, dict[str, str]] = {}
    for row in iter_opening_rows(data_dir or opening_data_dir()):
        name = row.get("name") or ""
        if not name or name in rows_by_name:
            continue
        rows_by_name[name] = row

    # Same idea as the opening-book skip marker: the TSVs only change on
    # deploys, and a full pass replays thousands of PGNs and runs hundreds of
    # queries - not something to repeat every maintenance cycle.
    fingerprint = f"names:{len(rows_by_name)}"
    if await _families_already_seeded(session, fingerprint):
        return 0

    existing_result = await session.execute(select(OpeningFamily))
    families_by_name = {
        family.full_name: family for family in existing_result.scalars().all()
    }

    inserted = 0
    for row_idx, (full_name, row) in enumerate(sorted(rows_by_name.items(), key=lambda item: len(parse_family_segments(item[0])))):
        if row_idx % 50 == 0:
            await asyncio.sleep(0)
        segments = parse_family_segments(full_name)
        if not segments:
            continue

        parent: OpeningFamily | None = None
        current_name_parts: list[str] = []
        for index, segment in enumerate(segments):
            current_name_parts.append(segment)
            current_full_name = (
                current_name_parts[0]
                if len(current_name_parts) == 1
                else f"{current_name_parts[0]}: {', '.join(current_name_parts[1:])}"
            )
            family = families_by_name.get(current_full_name)
            if family is None:
                family = OpeningFamily(
                    parent_id=parent.id if parent else None,
                    full_name=current_full_name,
                    display_name=segment,
                    eco=row.get("eco") or None,
                    root_fen=compute_root_fen(row["pgn"]),
                    pgn=row["pgn"],
                    depth=index,
                    is_main_line=segment == "Main Line",
                )
                session.add(family)
                await session.flush()
                families_by_name[current_full_name] = family
                inserted += 1
            elif current_full_name == full_name:
                family.eco = row.get("eco") or family.eco
                family.root_fen = compute_root_fen(row["pgn"])
                family.pgn = row["pgn"]
                family.is_main_line = family.is_main_line or segment == "Main Line"

            parent = family

    # Main-line normalization over the in-memory set: one pass instead of one
    # child query per parent (that was ~640 queries per maintenance cycle).
    children_by_parent: dict[int, list[OpeningFamily]] = {}
    for family in families_by_name.values():
        if family.parent_id is not None:
            children_by_parent.setdefault(family.parent_id, []).append(family)
    for idx, children in enumerate(children_by_parent.values()):
        if idx % 200 == 0:
            await asyncio.sleep(0)
        if any(child.is_main_line for child in children):
            continue
        shortest = min(children, key=lambda child: (_pgn_ply_count(child.pgn), child.display_name))
        shortest.is_main_line = True

    await _mark_families_seeded(session, fingerprint)
    await session.flush()
    return inserted


async def load_family_tree(
    session: AsyncSession,
    root_id: int | None = None,
) -> list[OpeningFamily]:
    query = select(OpeningFamily)
    if root_id is None:
        query = query.where(OpeningFamily.parent_id.is_(None))
    else:
        query = query.where(OpeningFamily.parent_id == root_id)
    result = await session.execute(
        query.order_by(OpeningFamily.depth.asc(), OpeningFamily.display_name.asc())
    )
    return list(result.scalars().all())


_FAMILY_STATS_TTL_SECONDS = 600.0  # imports clear this cache


async def _family_counts(
    session: AsyncSession,
    root_fens: list[str],
    username: str,
    color: str,
    time_class: str | None,
) -> dict[str, list[int]]:
    filters = [Game.username == username]
    if color != "both":
        filters.append(Game.user_color == color)
    time_filter = time_class_condition(Game.time_class, time_class)
    if time_filter is not None:
        filters.append(time_filter)

    # Scope games first so shared opening positions do not trigger a separate
    # lookup in games for every visit by every player.
    user_games = (
        select(Game.id, Game.user_result)
        .where(*filters)
        .cte("user_games")
        .prefix_with("MATERIALIZED")
    )
    rows = await session.execute(
        select(
            Position.fen,
            func.count(func.distinct(user_games.c.id)),
            func.sum(case((user_games.c.user_result == "win", 1), else_=0)),
        )
        .select_from(Position)
        .join(GamePosition, GamePosition.position_id == Position.id)
        .join(user_games, user_games.c.id == GamePosition.game_id)
        .where(Position.fen.in_(root_fens))
        .group_by(Position.fen)
    )
    return {fen: [int(count), int(wins or 0)] for fen, count, wins in rows}


def _family_stats(count: int = 0, wins: int = 0) -> dict[str, float | int]:
    return {"game_count": count, "win_rate": round(wins / count, 4) if count else 0.0}


async def family_user_stats_bulk(
    session: AsyncSession,
    families: list[OpeningFamily],
    username: str | None,
    color: str = "both",
    time_class: str | None = None,
) -> dict[int, dict[str, float | int]]:
    if not username or not families:
        return {family.id: _family_stats() for family in families}

    root_fens = sorted({family.root_fen for family in families})
    fens_digest = hashlib.md5("|".join(root_fens).encode()).hexdigest()
    suffix = f"{color}:{time_class}:{fens_digest}"

    async def compute(db: AsyncSession) -> dict[str, list[int]]:
        return await _family_counts(db, root_fens, username, color, time_class)

    # Imports invalidate both the fresh and last-known entries by prefix.
    cached = await stale_while_revalidate(
        session,
        fresh_base=f"famstats:{username}:{suffix}",
        last_key=f"famstats:{username}:last:{suffix}",
        compute=compute,
        fresh_ttl=_FAMILY_STATS_TTL_SECONDS,
    )
    return {
        family.id: _family_stats(*cached.get(family.root_fen, (0, 0)))
        for family in families
    }


async def family_child_counts(
    session: AsyncSession,
    family_ids: list[int],
) -> dict[int, int]:
    if not family_ids:
        return {}
    result = await session.execute(
        select(OpeningFamily.parent_id, func.count())
        .where(OpeningFamily.parent_id.in_(family_ids))
        .group_by(OpeningFamily.parent_id)
    )
    return {row[0]: row[1] for row in result.all()}


async def family_user_stats(
    session: AsyncSession,
    family_id: int,
    username: str | None,
    color: str = "both",
    time_class: str | None = None,
) -> dict[str, float | int]:
    if not username:
        return _family_stats()

    family = await session.get(OpeningFamily, family_id)
    if family is None:
        return _family_stats()

    counts = await _family_counts(session, [family.root_fen], username, color, time_class)
    return _family_stats(*counts.get(family.root_fen, (0, 0)))
