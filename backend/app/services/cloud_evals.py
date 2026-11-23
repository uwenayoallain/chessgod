from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import chess
import httpx
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.engine_contract import ENGINE_NAME, ENGINE_VERSION
from app.models.analysis import AnalysisResult
from app.models.cloud_evaluation import CloudEvaluation
from app.models.game import Game
from app.services.cache import get_shared_cache
from app.models.external_sync_state import ExternalSyncState
from app.models.game_position import GamePosition
from app.models.position import Position
from app.services.improvement import invalidate_improvement_caches_for_positions
from app.services.game_scope import user_rating_condition

# The server has no CPU budget for a local engine (the old analysis-worker was
# removed), so "server-side analysis" means asking the Lichess Cloud Eval API —
# a free read-only cache of deep engine analyses — for positions from imported
# games. Cache misses are left for the in-browser wasm engine to fill.
CLOUD_EVAL_PROVIDER = "lichess_cloud_eval"
CLOUD_ENGINE_NAME = "lichess-cloud"

logger = logging.getLogger(__name__)
_GAME_CHUNK_SIZE = 250


@dataclass(frozen=True)
class CloudEval:
    depth: int
    eval_cp: int | None
    eval_mate: int | None
    best_move_uci: str
    best_move_san: str
    pv_uci: str
    pv_san: str


def _full_fen(fen: str) -> str:
    # Positions store normalized 4-field FENs; python-chess and Lichess want
    # the halfmove/fullmove counters present.
    return fen if len(fen.split(" ")) >= 6 else f"{fen} 0 1"


def parse_cloud_eval(fen: str, payload: dict) -> CloudEval | None:
    pvs = payload.get("pvs") or []
    depth = payload.get("depth")
    if not pvs or not isinstance(depth, int):
        return None
    moves = str(pvs[0].get("moves") or "").split()
    if not moves:
        return None

    board = chess.Board(_full_fen(fen))
    san_moves: list[str] = []
    for uci in moves:
        try:
            move = chess.Move.from_uci(uci)
            san_moves.append(board.san(move))
            board.push(move)
        except ValueError:
            break
    if not san_moves:
        return None

    return CloudEval(
        depth=depth,
        eval_cp=pvs[0].get("cp"),
        eval_mate=pvs[0].get("mate"),
        best_move_uci=moves[0],
        best_move_san=san_moves[0],
        pv_uci=" ".join(moves[: len(san_moves)]),
        pv_san=" ".join(san_moves),
    )


class LichessCloudEvalClient:
    def __init__(self, http_client: httpx.AsyncClient) -> None:
        self._client = http_client

    async def fetch(self, fen: str) -> CloudEval | None:
        """Return the cached evaluation for ``fen``, or None on a cache miss.

        Raises httpx.HTTPStatusError for throttling/auth responses so the
        caller can persist a cooldown.
        """
        response = await self._client.get(
            settings.lichess_cloud_eval_url,
            params={"fen": _full_fen(fen), "multiPv": 1},
            timeout=settings.lichess_cloud_eval_timeout_seconds,
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return parse_cloud_eval(fen, response.json())


# Lichess answers 404 for positions it has never analyzed; remember those in
# the shared cache so runs (and restarts) don't burn quota re-asking about the
# same rare lines.
def _miss_key(fen: str) -> str:
    return f"cloudeval:miss:{fen}"


async def _is_known_miss(fen: str) -> bool:
    return await get_shared_cache().get_json(_miss_key(fen)) is not None


async def _note_miss(fen: str) -> None:
    await get_shared_cache().set_json(
        _miss_key(fen),
        1,
        ttl_seconds=settings.lichess_cloud_eval_negative_ttl_hours * 3600,
    )


async def _load_cooldown(session: AsyncSession) -> ExternalSyncState | None:
    return await session.get(ExternalSyncState, CLOUD_EVAL_PROVIDER)


def _cooldown_active(state: ExternalSyncState | None) -> bool:
    if state is None or state.cooldown_until is None:
        return False
    until = state.cooldown_until
    if until.tzinfo is None:
        until = until.replace(tzinfo=UTC)
    return until > datetime.now(UTC)


async def _set_cooldown(session: AsyncSession, *, status_code: int, seconds: int) -> None:
    state = await _load_cooldown(session)
    if state is None:
        state = ExternalSyncState(provider=CLOUD_EVAL_PROVIDER)
        session.add(state)
    state.cooldown_until = datetime.now(UTC) + timedelta(seconds=max(seconds, 1))
    state.last_status_code = status_code
    state.last_error = "rate_limit" if status_code == 429 else "http_error"
    state.updated_at = datetime.now(UTC)
    await session.flush()


async def choose_unanalyzed_positions(
    session: AsyncSession,
    *,
    min_depth: int,
    max_ply: int | None,
    min_games: int,
    limit: int,
    min_user_rating: int,
) -> list[tuple[int, str]]:
    """Relevant Rapid/Blitz positions with no eval at ``min_depth``.

    Most-played positions first: they matter most for the theory/mistakes
    features and are the likeliest to be in the Lichess cloud cache.

    Game IDs are walked newest-first in bounded chunks. Each pass starts at the
    newest games, but already-covered positions fall out, so later runs advance
    through the complete corpus without one global game_positions scan.
    """
    # A position needs no further cloud request when it already has either the
    # active Stockfish 19 evidence or an equally deep cloud cache row. Legacy
    # providers are deliberately ignored; they neither satisfy the active
    # contract nor suppress a useful cloud lookup.
    already_analyzed = or_(
        select(AnalysisResult.id)
        .where(
            AnalysisResult.position_id == Position.id,
            AnalysisResult.engine == ENGINE_NAME,
            AnalysisResult.engine_version == ENGINE_VERSION,
            AnalysisResult.depth >= min_depth,
            AnalysisResult.multipv_rank == 1,
        )
        .exists(),
        select(CloudEvaluation.id)
        .where(
            CloudEvaluation.position_id == Position.id,
            CloudEvaluation.depth >= min_depth,
            CloudEvaluation.multipv_rank == 1,
        )
        .exists(),
    )
    game_rows = await session.execute(
        select(Game.id)
        .where(
            Game.time_class.in_(("rapid", "blitz")),
            user_rating_condition(Game, min_user_rating),
        )
        .order_by(Game.played_at.desc(), Game.id.desc())
    )
    game_ids = [int(game_id) for game_id in game_rows.scalars()]

    selected: list[tuple[int, str]] = []
    selected_ids: set[int] = set()
    for offset in range(0, len(game_ids), _GAME_CHUNK_SIZE):
        chunk = game_ids[offset : offset + _GAME_CHUNK_SIZE]
        position_conditions = [GamePosition.game_id.in_(chunk)]
        if max_ply is not None:
            position_conditions.append(GamePosition.ply <= max_ply)
        chunk_position_ids = (
            select(GamePosition.position_id)
            .where(*position_conditions)
            .distinct()
            .subquery()
        )
        rows = await session.execute(
            select(Position.id, Position.fen)
            .join(
                chunk_position_ids,
                chunk_position_ids.c.position_id == Position.id,
            )
            .where(
                Position.total_games >= min_games,
                ~Position.fen.like("%[%"),
                ~already_analyzed,
                Position.id.not_in(selected_ids) if selected_ids else True,
            )
            .order_by(Position.total_games.desc(), Position.id.asc())
            .limit(limit - len(selected))
        )
        for position_id, fen in rows.all():
            value = int(position_id)
            if value in selected_ids:
                continue
            selected.append((value, fen))
            selected_ids.add(value)
        if len(selected) >= limit:
            break
    return selected


async def store_cloud_eval(
    session: AsyncSession, *, position_id: int, evaluation: CloudEval
) -> bool:
    existing = await session.scalar(
        select(CloudEvaluation)
        .where(
            CloudEvaluation.position_id == position_id,
            CloudEvaluation.multipv_rank == 1,
        )
        # Rows are keyed by depth now, so ask for the deepest one explicitly
        # rather than whichever the planner returns first.
        .order_by(CloudEvaluation.depth.desc(), CloudEvaluation.id.desc())
        .limit(1)
    )
    if existing is not None and existing.depth >= evaluation.depth:
        return False
    if existing is None:
        session.add(
            CloudEvaluation(
                position_id=position_id,
                engine=CLOUD_ENGINE_NAME,
                engine_version=None,
                depth=evaluation.depth,
                eval_cp=evaluation.eval_cp,
                eval_mate=evaluation.eval_mate,
                best_move_uci=evaluation.best_move_uci,
                best_move_san=evaluation.best_move_san,
                pv_uci=evaluation.pv_uci,
                pv_san=evaluation.pv_san,
                multipv_rank=1,
            )
        )
    else:
        existing.depth = evaluation.depth
        existing.eval_cp = evaluation.eval_cp
        existing.eval_mate = evaluation.eval_mate
        existing.best_move_uci = evaluation.best_move_uci
        existing.best_move_san = evaluation.best_move_san
        existing.pv_uci = evaluation.pv_uci
        existing.pv_san = evaluation.pv_san
        existing.analyzed_at = datetime.now(UTC)
    await session.flush()
    return True


async def sync_cloud_evals(
    session: AsyncSession,
    client: LichessCloudEvalClient,
    *,
    max_positions: int | None = None,
) -> dict[str, int]:
    """One fetch pass. Returns counters for the observability panel."""
    meta = {
        "queued": 0,
        "stored": 0,
        "misses": 0,
        "skipped_known_misses": 0,
        "too_shallow": 0,
    }
    changed_position_ids: set[int] = set()
    state = await _load_cooldown(session)
    if _cooldown_active(state):
        return meta

    candidates = await choose_unanalyzed_positions(
        session,
        min_depth=settings.lichess_cloud_eval_min_depth,
        max_ply=settings.lichess_cloud_eval_max_ply,
        min_games=settings.lichess_cloud_eval_min_games,
        limit=max_positions or settings.lichess_cloud_eval_max_positions_per_run,
        min_user_rating=settings.lichess_cloud_eval_min_user_rating,
    )
    meta["queued"] = len(candidates)

    for position_id, fen in candidates:
        if await _is_known_miss(fen):
            meta["skipped_known_misses"] += 1
            continue
        try:
            evaluation = await client.fetch(fen)
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code if exc.response is not None else 0
            await _set_cooldown(
                session,
                status_code=status_code,
                seconds=settings.lichess_cloud_eval_rate_limit_cooldown_seconds,
            )
            await session.commit()
            logger.warning(
                "Cloud eval sync stopped on HTTP %s; cooling down", status_code
            )
            break
        except httpx.HTTPError as exc:
            logger.warning("Cloud eval sync stopped on network error: %s", exc)
            break

        if evaluation is None:
            await _note_miss(fen)
            meta["misses"] += 1
        elif evaluation.depth < settings.lichess_cloud_eval_min_depth:
            # min_depth also picks candidates, but Lichess can answer shallower
            # than we asked. Storing that anyway would mix depths in one column,
            # and mistake detection differences a parent and child eval — so a
            # shallow neighbour reads as a phantom eval drop. Negative-cache it
            # so the next pass (after the TTL) can pick up a deepened eval
            # instead of re-requesting it every run.
            await _note_miss(fen)
            meta["too_shallow"] += 1
        elif await store_cloud_eval(session, position_id=position_id, evaluation=evaluation):
            meta["stored"] += 1
            changed_position_ids.add(position_id)
            if meta["stored"] % 50 == 0:
                await session.commit()
                await invalidate_improvement_caches_for_positions(
                    session, changed_position_ids
                )
                changed_position_ids.clear()

        await asyncio.sleep(settings.lichess_cloud_eval_request_delay)

    await session.commit()
    await invalidate_improvement_caches_for_positions(session, changed_position_ids)
    return meta
