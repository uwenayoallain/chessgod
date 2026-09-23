from __future__ import annotations

import asyncio
import csv
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path

import chess
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.engine_contract import ENGINE_NAME, ENGINE_VERSION
from app.models.analysis import AnalysisResult
from app.models.external_sync_state import ExternalSyncState
from app.models.position import Position
from app.models.position_move import PositionMove
from app.services.theory import LichessExplorerClient, cache_is_stale, load_moves_for_position, refresh_master_data
from app.utils.fen import normalize_fen


BOOK_TSV_FILES = ("a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv")
LICHESS_SYNC_PROVIDER = "lichess_opening_explorer"

logger = logging.getLogger(__name__)


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _parse_retry_after_seconds(header_value: str | None) -> int | None:
    if not header_value:
        return None
    try:
        parsed = int(header_value)
    except ValueError:
        return None
    if parsed <= 0:
        return None
    return parsed


async def _load_sync_state(session: AsyncSession) -> ExternalSyncState | None:
    return await session.get(ExternalSyncState, LICHESS_SYNC_PROVIDER)


def _is_cooldown_active(state: ExternalSyncState | None) -> bool:
    if state is None or state.cooldown_until is None:
        return False
    cooldown_until = state.cooldown_until
    if cooldown_until.tzinfo is None:
        cooldown_until = cooldown_until.replace(tzinfo=UTC)
    return cooldown_until > _now_utc()


async def _set_cooldown(
    session: AsyncSession,
    *,
    status_code: int | None,
    error: str,
    duration_seconds: int,
) -> None:
    state = await _load_sync_state(session)
    cooldown_until = _now_utc() + timedelta(seconds=max(duration_seconds, 1))
    if state is None:
        state = ExternalSyncState(provider=LICHESS_SYNC_PROVIDER)
        session.add(state)

    state.cooldown_until = cooldown_until
    state.last_status_code = status_code
    state.last_error = error
    state.updated_at = _now_utc()
    await session.flush()


async def _clear_cooldown(session: AsyncSession) -> None:
    state = await _load_sync_state(session)
    if state is None:
        return
    state.cooldown_until = None
    state.last_status_code = None
    state.last_error = None
    state.updated_at = _now_utc()
    await session.flush()


def opening_data_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "data" / "openings"


def extract_san_moves(pgn_line: str) -> list[str]:
    tokens = pgn_line.strip().split()
    moves: list[str] = []

    for token in tokens:
        stripped = token.strip()
        if not stripped or stripped in {"1-0", "0-1", "1/2-1/2", "*"}:
            continue
        if stripped[0].isdigit() and "." in stripped:
            if stripped.endswith("..."):
                continue
            stripped = stripped.split(".")[-1].strip()
            if not stripped:
                continue
        moves.append(stripped)

    return moves


def iter_opening_rows(data_dir: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for filename in BOOK_TSV_FILES:
        file_path = data_dir / filename
        if not file_path.exists():
            continue
        with file_path.open("r", encoding="utf-8") as handle:
            reader = csv.DictReader(handle, delimiter="\t")
            rows.extend(
                {
                    "eco": (row.get("eco") or "").strip(),
                    "name": (row.get("name") or "").strip(),
                    "pgn": (row.get("pgn") or "").strip(),
                }
                for row in reader
                if (row.get("pgn") or "").strip()
            )
    return rows


BOOK_SEED_PROVIDER = "opening_book_seed"
_FEN_CHUNK = 1000


async def _book_already_seeded(session: AsyncSession, fingerprint: str) -> bool:
    state = await session.get(ExternalSyncState, BOOK_SEED_PROVIDER)
    return state is not None and state.last_error == fingerprint


async def _mark_book_seeded(session: AsyncSession, fingerprint: str) -> None:
    state = await session.get(ExternalSyncState, BOOK_SEED_PROVIDER)
    if state is None:
        state = ExternalSyncState(provider=BOOK_SEED_PROVIDER)
        session.add(state)
    state.last_error = fingerprint
    state.updated_at = _now_utc()
    await session.flush()


async def _load_book_positions(
    session: AsyncSession, fens: set[str]
) -> dict[str, Position]:
    positions_by_fen: dict[str, Position] = {}
    fen_list = sorted(fens)
    for start in range(0, len(fen_list), _FEN_CHUNK):
        chunk = fen_list[start : start + _FEN_CHUNK]
        result = await session.execute(select(Position).where(Position.fen.in_(chunk)))
        for position in result.scalars().all():
            positions_by_fen[position.fen] = position
    return positions_by_fen


async def _load_book_moves(
    session: AsyncSession, position_ids: list[int]
) -> dict[tuple[int, str], PositionMove]:
    moves_by_key: dict[tuple[int, str], PositionMove] = {}
    for start in range(0, len(position_ids), _FEN_CHUNK):
        chunk = position_ids[start : start + _FEN_CHUNK]
        result = await session.execute(
            select(PositionMove).where(PositionMove.from_position_id.in_(chunk))
        )
        for move in result.scalars().all():
            moves_by_key[(move.from_position_id, move.move_uci)] = move
    return moves_by_key


async def seed_opening_book(session: AsyncSession, data_dir: Path | None = None) -> int:
    source_dir = data_dir or opening_data_dir()
    rows = iter_opening_rows(source_dir)

    # Skip marker: re-seeding is idempotent but expensive, and the bundled TSVs
    # only change on deploys. Never load the whole positions/position_moves
    # tables here — at millions of rows that blocked the event loop for tens
    # of seconds and froze every request while the app started.
    fingerprint = f"lines:{len(rows)}"
    if await _book_already_seeded(session, fingerprint):
        return 0

    book_fens: set[str] = set()
    for row_idx, row in enumerate(rows):
        if row_idx % 50 == 0:
            await asyncio.sleep(0)
        board = chess.Board()
        book_fens.add(normalize_fen(board.fen()))
        for san in extract_san_moves(row["pgn"]):
            try:
                board.push(board.parse_san(san))
            except ValueError:
                break
            book_fens.add(normalize_fen(board.fen()))

    positions_by_fen = await _load_book_positions(session, book_fens)
    moves_by_key = await _load_book_moves(
        session, [position.id for position in positions_by_fen.values()]
    )

    seeded_lines = 0
    for row_idx, row in enumerate(rows):
        if row_idx % 50 == 0:
            await asyncio.sleep(0)
        board = chess.Board()
        san_moves = extract_san_moves(row["pgn"])
        if not san_moves:
            continue

        seeded_lines += 1
        for ply, san in enumerate(san_moves, start=1):
            parent_fen = normalize_fen(board.fen())
            parent = positions_by_fen.get(parent_fen)
            if parent is None:
                parent = Position(
                    fen=parent_fen,
                    total_games=0,
                    white_wins=0,
                    draws=0,
                    black_wins=0,
                )
                session.add(parent)
                await session.flush()
                positions_by_fen[parent_fen] = parent

            if ply > 1 and parent.master_opening_name is None:
                parent.master_opening_name = row["name"] or None
                parent.master_eco = row["eco"] or None

            try:
                move = board.parse_san(san)
            except ValueError:
                break

            move_uci = move.uci()
            board.push(move)
            child_fen = normalize_fen(board.fen())
            child = positions_by_fen.get(child_fen)
            if child is None:
                child = Position(
                    fen=child_fen,
                    total_games=0,
                    white_wins=0,
                    draws=0,
                    black_wins=0,
                    master_eco=row["eco"] or None,
                    master_opening_name=row["name"] or None,
                )
                session.add(child)
                await session.flush()
                positions_by_fen[child_fen] = child
            elif child.master_opening_name is None:
                child.master_opening_name = row["name"] or None
                child.master_eco = row["eco"] or None

            existing_move = moves_by_key.get((parent.id, move_uci))
            if existing_move is None:
                existing_move = PositionMove(
                    from_position_id=parent.id,
                    to_position_id=child.id,
                    move_san=san,
                    move_uci=move_uci,
                    move_number=ply,
                    is_white_move=ply % 2 == 1,
                    game_count=0,
                    white_wins=0,
                    draws=0,
                    black_wins=0,
                    master_game_count=0,
                    master_white_wins=0,
                    master_draws=0,
                    master_black_wins=0,
                )
                session.add(existing_move)
                await session.flush()
                moves_by_key[(parent.id, move_uci)] = existing_move
            else:
                existing_move.to_position_id = child.id
                existing_move.move_san = san
                existing_move.move_number = ply
                existing_move.is_white_move = ply % 2 == 1
                if existing_move.master_game_count is None:
                    existing_move.master_game_count = 0
                    existing_move.master_white_wins = 0
                    existing_move.master_draws = 0
                    existing_move.master_black_wins = 0

    await _mark_book_seeded(session, fingerprint)
    return seeded_lines


async def sync_stale_master_data(
    session: AsyncSession,
    client: LichessExplorerClient,
    *,
    force: bool = False,
    batch_size: int = 50,
    min_position_games: int = 0,
    max_positions: int | None = None,
) -> int:
    sync_state = await _load_sync_state(session)
    if _is_cooldown_active(sync_state):
        logger.info(
            "Skipping master opening sync during cooldown",
            extra={
                "cooldown_until": sync_state.cooldown_until.isoformat() if sync_state and sync_state.cooldown_until else None,
                "last_status_code": sync_state.last_status_code if sync_state else None,
            },
        )
        return 0

    has_moves = (
        select(PositionMove.id)
        .where(PositionMove.from_position_id == Position.id)
        .exists()
    )
    has_evaluation = (
        select(AnalysisResult.id)
        .where(
            AnalysisResult.position_id == Position.id,
            AnalysisResult.engine == ENGINE_NAME,
            AnalysisResult.engine_version == ENGINE_VERSION,
        )
        .exists()
    )
    filters = [Position.total_games >= min_position_games, has_moves]
    if not force:
        # Staleness must live in SQL: with a Python-side check, a capped run
        # kept re-reading the same already-fresh top rows and never advanced
        # through the corpus (millions of positions here).
        stale_cutoff = _now_utc() - timedelta(days=settings.lichess_cache_ttl_days)
        filters.append(
            (Position.master_fetched_at.is_(None))
            | (Position.master_fetched_at < stale_cutoff)
        )

    # Positions with a stored engine evaluation come first: recurring-mistake
    # detection needs master stats and an eval for the same position, so those
    # rows are worth the Lichess quota most. Two queries instead of one ORDER BY
    # has_evaluation: sorting the whole positions table on that expression took
    # ~16s and starved the API at startup; driving off the small analysis_results
    # set and topping up via the total_games index runs in well under a second.
    cap = max_positions if max_positions is not None and max_positions > 0 else None
    evaluated_query = (
        select(Position)
        .where(
            Position.id.in_(
                select(AnalysisResult.position_id)
                .where(
                    AnalysisResult.engine == ENGINE_NAME,
                    AnalysisResult.engine_version == ENGINE_VERSION,
                )
                .distinct()
            ),
            *filters,
        )
        .order_by(Position.total_games.desc(), Position.id.asc())
    )
    if cap is not None:
        evaluated_query = evaluated_query.limit(cap)
    candidates = list((await session.execute(evaluated_query)).scalars().all())

    remaining = None if cap is None else cap - len(candidates)
    if remaining is None or remaining > 0:
        fill_query = (
            select(Position)
            .where(~has_evaluation, *filters)
            .order_by(Position.total_games.desc(), Position.id.asc())
        )
        if remaining is not None:
            fill_query = fill_query.limit(remaining)
        candidates.extend((await session.execute(fill_query)).scalars().all())

    refreshed = 0

    for idx, position in enumerate(candidates):
        if idx % 100 == 0:
            await asyncio.sleep(0)

        if not force and not cache_is_stale(position.master_fetched_at):
            continue

        moves = await load_moves_for_position(session, position.id)
        if not moves:
            continue

        try:
            await refresh_master_data(session, client, position, moves)
        except httpx.RequestError:
            await _set_cooldown(
                session, status_code=None, error="network_unavailable",
                duration_seconds=settings.lichess_sync_cooldown_rate_limit_seconds,
            )
            logger.warning("Pausing master opening sync after network failure")
            break
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code if exc.response is not None else None
            if status_code is not None and 500 <= status_code < 600:
                retry_after = _parse_retry_after_seconds(exc.response.headers.get("Retry-After"))
                await _set_cooldown(
                    session, status_code=status_code, error="upstream_unavailable",
                    duration_seconds=max(settings.lichess_sync_cooldown_rate_limit_seconds, retry_after or 0),
                )
                logger.warning("Pausing master opening sync after upstream failure", extra={"status_code": status_code})
                break
            if exc.response is not None and exc.response.status_code in {401, 403}:
                await _set_cooldown(
                    session,
                    status_code=exc.response.status_code,
                    error="authorization",
                    duration_seconds=settings.lichess_sync_cooldown_auth_minutes * 60,
                )
                logger.warning(
                    "Skipping master opening sync after authorization error",
                    extra={"status_code": exc.response.status_code, "fen": position.fen},
                )
                break
            if status_code == 429:
                retry_after_seconds = _parse_retry_after_seconds(exc.response.headers.get("Retry-After") if exc.response else None)
                cooldown_seconds = max(
                    settings.lichess_sync_cooldown_rate_limit_seconds,
                    retry_after_seconds or 0,
                )
                await _set_cooldown(
                    session,
                    status_code=status_code,
                    error="rate_limit",
                    duration_seconds=cooldown_seconds,
                )
                logger.warning(
                    "Stopping master opening sync after rate limit response",
                    extra={
                        "status_code": status_code,
                        "retry_after": exc.response.headers.get("Retry-After") if exc.response else None,
                        "fen": position.fen,
                    },
                )
                break
            raise
        refreshed += 1
        if refreshed == 1:
            await _clear_cooldown(session)

        if refreshed % batch_size == 0:
            await session.commit()

    return refreshed


async def seconds_until_sync_retry(session: AsyncSession) -> float | None:
    """How long until a cooled-down explorer sync is worth attempting again.

    The maintenance loop used to sleep `lichess_sync_interval_hours` after every
    run whatever ended it, so a run cut short by a rate-limit cooldown -- which
    is most of them, the explorer 429s after about twenty requests -- did not
    retry for six hours. That capped master-data collection at roughly one
    short burst per six hours, about 23 positions, regardless of how brief the
    cooldown itself was: shortening the cooldown alone changed nothing.

    Returns None when no cooldown is pending, in which case the caller keeps its
    normal interval.
    """

    state = await _load_sync_state(session)
    if not _is_cooldown_active(state):
        return None
    cooldown_until = state.cooldown_until
    if cooldown_until.tzinfo is None:
        cooldown_until = cooldown_until.replace(tzinfo=UTC)
    # A second of slack, so waking up fractionally early does not spend the
    # attempt re-reading an unexpired cooldown.
    return max((cooldown_until - _now_utc()).total_seconds() + 1.0, 1.0)
