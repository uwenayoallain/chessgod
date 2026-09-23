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
from app.services.cache import get_shared_cache
from app.services.game_scope import time_class_condition
from app.models.game_position import GamePosition
from app.models.opening_family import OpeningFamily
from app.models.position import Position
from app.services.master_openings import iter_opening_rows, opening_data_dir, extract_san_moves
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
    # queries — not something to repeat every maintenance cycle.
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


# Root-fen stats join Game x GamePosition x Position over popular openings
# (~1s cold) and the same family sets are re-requested constantly while
# browsing the tree, so cache per (user, filters, fen-set) for a minute.
_FAMILY_STATS_TTL_SECONDS = 600.0  # imports clear it; see the warmup note in main.py


def _fill_family_stats(
    families: list[OpeningFamily],
    stats_by_fen: dict[str, tuple[int, int]],
    out: dict[int, dict[str, float | int]],
) -> dict[int, dict[str, float | int]]:
    for family in families:
        count, wins = stats_by_fen.get(family.root_fen, (0, 0))
        out[family.id] = {
            "game_count": int(count),
            "win_rate": round(wins / count, 4) if count else 0.0,
        }
    return out


async def family_user_stats_bulk(
    session: AsyncSession,
    families: list[OpeningFamily],
    username: str | None,
    color: str = "both",
    time_class: str | None = None,
) -> dict[int, dict[str, float | int]]:
    empty: dict[int, dict[str, float | int]] = {
        f.id: {"game_count": 0, "win_rate": 0.0} for f in families
    }
    if not username or not families:
        return empty

    root_fens = list({f.root_fen for f in families})
    fens_digest = hashlib.md5("|".join(sorted(root_fens)).encode()).hexdigest()
    cache = get_shared_cache()
    cache_key = f"famstats:{username}:{color}:{time_class}:{fens_digest}"
    cache_key = await cache.versioned_key(cache_key)
    cached = await cache.get_json(cache_key)
    if cached is not None:
        return _fill_family_stats(
            families, {fen: (int(c), int(w)) for fen, (c, w) in cached.items()}, empty
        )

    filters = [Game.username == username, Position.fen.in_(root_fens)]
    if color != "both":
        filters.append(Game.user_color == color)
    time_filter = time_class_condition(Game.time_class, time_class)
    if time_filter is not None:
        filters.append(time_filter)

    result = await session.execute(
        select(
            Position.fen,
            func.count(func.distinct(Game.id)),
            func.sum(case((Game.user_result == "win", 1), else_=0)),
        )
        .select_from(Game)
        .join(GamePosition, GamePosition.game_id == Game.id)
        .join(Position, Position.id == GamePosition.position_id)
        .where(*filters)
        .group_by(Position.fen)
    )
    stats_by_fen: dict[str, tuple[int, int]] = {
        row[0]: (row[1] or 0, row[2] or 0) for row in result.all()
    }
    await cache.set_json(
        cache_key,
        {fen: [count, wins] for fen, (count, wins) in stats_by_fen.items()},
        ttl_seconds=_FAMILY_STATS_TTL_SECONDS,
    )
    return _fill_family_stats(families, stats_by_fen, empty)


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
        return {"game_count": 0, "win_rate": 0.0}

    family = await session.get(OpeningFamily, family_id)
    if family is None:
        return {"game_count": 0, "win_rate": 0.0}

    filters = [Game.username == username, Position.fen == family.root_fen]
    if color != "both":
        filters.append(Game.user_color == color)
    time_filter = time_class_condition(Game.time_class, time_class)
    if time_filter is not None:
        filters.append(time_filter)

    result = await session.execute(
        select(
            func.count(func.distinct(Game.id)),
            func.sum(case((Game.user_result == "win", 1), else_=0)),
        )
        .select_from(Game)
        .join(GamePosition, GamePosition.game_id == Game.id)
        .join(Position, Position.id == GamePosition.position_id)
        .where(*filters)
    )
    game_count, wins = result.one()
    game_count = game_count or 0
    wins = wins or 0
    return {
        "game_count": game_count,
        "win_rate": round(wins / game_count, 4) if game_count else 0.0,
    }
