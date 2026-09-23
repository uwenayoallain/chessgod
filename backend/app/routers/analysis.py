from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

import chess
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.engine_contract import ENGINE_NAME, ENGINE_VERSION
from app.models.analysis import AnalysisResult
from app.models.position import Position
from app.schemas.analysis import (
    AnalysisEvaluationBatchIn,
    AnalysisEvaluationOut,
    AnalysisResultOut,
    MoveExplanationOut,
    MoveExplanationsIn,
    RecurringMistakeOut,
)
from app.services.analysis import get_analysis_for_position
from app.services.improvement import classify_pattern, invalidate_improvement_caches_for_positions
from app.services.mistakes import find_mistakes_cached
from app.utils.fen import normalize_fen

router = APIRouter()

_PIECE_NAMES = {
    chess.PAWN: "pawn", chess.KNIGHT: "knight", chess.BISHOP: "bishop",
    chess.ROOK: "rook", chess.QUEEN: "queen",
}


def _explain(item) -> MoveExplanationOut | None:
    """Name what a review's costly move did, with the classifier the drills use."""
    fen = item.fen if len(item.fen.split()) == 6 else f"{item.fen} 0 1"
    try:
        board = chess.Board(fen)
        user_move = chess.Move.from_uci(item.user_move_uci)
        best_move = chess.Move.from_uci(item.best_move_uci)
    except ValueError:
        return None
    if user_move not in board.legal_moves or best_move not in board.legal_moves:
        return None
    reply_uci = (item.reply_pv_uci or "").split()[0] if item.reply_pv_uci else None
    pattern = classify_pattern(
        fen=normalize_fen(board.fen()),
        ply=item.ply,
        user_move_uci=item.user_move_uci,
        best_move_uci=item.best_move_uci,
        opponent_reply_uci=reply_uci,
        parent_eval_cp=item.parent_eval_cp,
        mover_is_white=board.turn == chess.WHITE,
        eval_drop_cp=item.eval_drop_cp,
        user_move_san=board.san(user_move),
        best_move_san=board.san(best_move),
        best_pv_uci=item.best_pv_uci,
        reply_pv_uci=item.reply_pv_uci,
        best_eval_mate=item.best_eval_mate,
    )
    detail = None
    if pattern.motifs:
        motif = pattern.motifs[0]
        detail = f"{'Allowed' if motif.side == 'allowed' else 'Missed'}: {motif.detail}"
    elif reply_uci:
        # The reply that punished the move, when it simply takes something.
        after = board.copy(stack=False)
        after.push(user_move)
        try:
            reply = chess.Move.from_uci(reply_uci)
        except ValueError:
            reply = None
        if reply is not None and reply in after.legal_moves and after.is_capture(reply):
            captured = after.piece_at(reply.to_square)
            if captured is not None and captured.piece_type in _PIECE_NAMES:
                detail = f"{after.san(reply)} wins the {_PIECE_NAMES[captured.piece_type]}."
    return MoveExplanationOut(
        ply=item.ply, key=pattern.key, label=pattern.label, detail=detail, cue=pattern.cue,
    )

_EVALUATION_CONTENT_FIELDS = (
    "engine_version", "depth", "eval_cp", "eval_mate", "best_move_uci",
    "best_move_san", "pv_uci", "pv_san",
)


@router.get("/position", response_model=list[AnalysisResultOut])
async def get_position_analysis(
    fen: str = Query(..., max_length=120),
    depth: Annotated[int | None, Query(ge=1, le=128)] = None,
    session: AsyncSession = Depends(get_db),
) -> list[AnalysisResultOut]:
    position = await session.scalar(select(Position).where(Position.fen == normalize_fen(fen)))
    if position is None:
        return []
    rows = await get_analysis_for_position(session, position.id, depth)
    return [AnalysisResultOut.model_validate(row, from_attributes=True) for row in rows]


@router.get("/deviations")
async def analysis_deviations() -> list[dict]:
    return []


@router.get("/mistakes", response_model=list[RecurringMistakeOut])
async def recurring_mistakes(
    username: str = Query(...),
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    threshold_cp: Annotated[int, Query(ge=50, le=500)] = 50,
    min_occurrences: Annotated[int, Query(ge=1, le=100)] = 2,
    session: AsyncSession = Depends(get_db),
) -> list[RecurringMistakeOut]:
    mistakes = await find_mistakes_cached(
        session,
        username,
        color=color,
        time_class=time_class,
        threshold_cp=threshold_cp,
        min_occurrences=min_occurrences,
    )
    return [
        RecurringMistakeOut(
            fen=mistake.parent_fen,
            user_move={
                "san": mistake.user_move.san,
                "uci": mistake.user_move.uci or "",
                "game_count": mistake.occurrences,
            },
            best_move={
                "san": mistake.best_move.san,
                "uci": mistake.best_move.uci,
                "game_count": mistake.best_move.game_count,
            },
            cp_loss=mistake.eval_drop_cp,
            classification=mistake.severity,
            occurrences=mistake.occurrences,
            opening_context=mistake.family_name,
        )
        for mistake in mistakes
    ]


@router.post("/evaluations")
async def store_evaluations(
    payload: AnalysisEvaluationBatchIn,
    session: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    stored = 0
    skipped = 0
    upgraded = 0
    changed_position_ids: set[int] = set()

    unique_fens = sorted({item.fen for item in payload.items})
    position_map: dict[str, int] = {}
    for fen_batch_start in range(0, len(unique_fens), 100):
        fen_batch = unique_fens[fen_batch_start:fen_batch_start + 100]
        rows = await session.execute(
            # Serialize overlapping uploads, including the first insert where
            # no analysis row exists to lock. Consistent order avoids deadlocks.
            select(Position.fen, Position.id)
            .where(Position.fen.in_(fen_batch))
            .order_by(Position.fen)
            .with_for_update()
        )
        for fen, position_id in rows.all():
            position_map[fen] = position_id

    requested_keys = {
        (position_map[item.fen], item.engine, item.multipv_rank)
        for item in payload.items
        if item.fen in position_map
    }
    # A position keeps one row per searched depth, because a mistake is the
    # difference between two positions and the two sides have to be compared at
    # a depth they were both searched to. Index by depth as well, and remember
    # the deepest search already on record so a genuinely deeper one still
    # reports as an upgrade.
    existing_by_key: dict[tuple[int, str, int, int], AnalysisResult] = {}
    deepest_by_key: dict[tuple[int, str, int], int] = {}
    requested_depth_keys = {
        (position_map[item.fen], item.engine, item.multipv_rank, item.depth)
        for item in payload.items if item.fen in position_map
    }
    if requested_keys:
        deepest_rows = await session.execute(
            select(AnalysisResult.position_id, AnalysisResult.engine,
                   AnalysisResult.multipv_rank, func.max(AnalysisResult.depth))
            .where(tuple_(AnalysisResult.position_id, AnalysisResult.engine,
                          AnalysisResult.multipv_rank).in_(sorted(requested_keys)))
            .group_by(AnalysisResult.position_id, AnalysisResult.engine, AnalysisResult.multipv_rank)
        )
        deepest_by_key = {(pid, engine, rank): depth for pid, engine, rank, depth in deepest_rows.all()}
        existing_rows = await session.execute(
            select(AnalysisResult)
            .where(tuple_(AnalysisResult.position_id, AnalysisResult.engine,
                          AnalysisResult.multipv_rank, AnalysisResult.depth).in_(sorted(requested_depth_keys)))
        )
        for row in existing_rows.scalars().all():
            key = (row.position_id, row.engine, row.multipv_rank)
            existing_by_key.setdefault((*key, row.depth), row)

    received_at = datetime.now(UTC)
    for item in payload.items:
        position_id = position_map.get(item.fen)
        if position_id is None:
            skipped += 1
            continue

        position_key = (position_id, item.engine, item.multipv_rank)
        existing = existing_by_key.get((*position_key, item.depth))
        if existing is None:
            existing = AnalysisResult(
                position_id=position_id,
                engine=item.engine,
                engine_version=item.engine_version,
                depth=item.depth,
                eval_cp=item.eval_cp,
                eval_mate=item.eval_mate,
                best_move_uci=item.best_move_uci,
                best_move_san=item.best_move_san,
                pv_uci=item.pv_uci,
                pv_san=item.pv_san,
                multipv_rank=item.multipv_rank,
                analyzed_at=received_at,
            )
            session.add(existing)
            existing_by_key[(*position_key, item.depth)] = existing
            previous_deepest = deepest_by_key.get(position_key)
            if previous_deepest is not None and item.depth > previous_deepest:
                upgraded += 1
            deepest_by_key[position_key] = max(
                deepest_by_key.get(position_key, 0), item.depth
            )
            stored += 1
            changed_position_ids.add(position_id)
        elif all(
            getattr(existing, field) == getattr(item, field)
            for field in _EVALUATION_CONTENT_FIELDS
        ):
            # Retried uploads and repeated cached lines are not new evidence.
            # Preserve their age and the warm learning caches.
            skipped += 1
        else:
            # A fresh search of the same position to the same depth: keep the
            # newer numbers rather than a stale reading of the same evidence.
            existing.engine_version = item.engine_version
            existing.eval_cp = item.eval_cp
            existing.eval_mate = item.eval_mate
            existing.best_move_uci = item.best_move_uci
            existing.best_move_san = item.best_move_san
            existing.pv_uci = item.pv_uci
            existing.pv_san = item.pv_san
            existing.analyzed_at = received_at
            stored += 1
            changed_position_ids.add(position_id)

    await session.flush()
    # Invalidate only after the new evaluations are visible to other sessions.
    await session.commit()
    if changed_position_ids:
        await invalidate_improvement_caches_for_positions(session, changed_position_ids)
    return {"stored": stored, "skipped": skipped, "upgraded": upgraded}


@router.get("/evaluations", response_model=dict[str, AnalysisEvaluationOut])
async def get_evaluations(
    fens: str = Query(..., max_length=13_000),
    min_depth: int = Query(18, ge=1, le=128),
    session: AsyncSession = Depends(get_db),
) -> dict[str, AnalysisEvaluationOut]:
    requested_fens = [fen.strip() for fen in fens.split(",") if fen.strip()]
    if not requested_fens:
        return {}
    if len(requested_fens) > 100:
        raise HTTPException(status_code=422, detail="Request at most 100 positions per batch")
    if any(len(fen) > 120 for fen in requested_fens):
        raise HTTPException(status_code=422, detail="Each FEN must be at most 120 characters")
    lookup_fens = {fen: normalize_fen(fen) for fen in requested_fens}

    deepest_primary_id = (
        select(AnalysisResult.id)
        .where(
            AnalysisResult.position_id == Position.id,
            AnalysisResult.engine == ENGINE_NAME,
            AnalysisResult.engine_version == ENGINE_VERSION,
            AnalysisResult.depth >= min_depth,
            AnalysisResult.multipv_rank == 1,
        )
        .order_by(AnalysisResult.depth.desc(), AnalysisResult.id.desc())
        .limit(1)
        .correlate(Position)
        .scalar_subquery()
    )
    result = await session.execute(
        select(Position.fen, AnalysisResult)
        .join(AnalysisResult, AnalysisResult.id == deepest_primary_id)
        .where(Position.fen.in_(set(lookup_fens.values())))
        .order_by(Position.fen.asc())
    )
    evaluations: dict[str, AnalysisEvaluationOut] = {}
    for fen, row in result.all():
        evaluations[fen] = AnalysisEvaluationOut(
            depth=row.depth,
            eval_cp=row.eval_cp,
            eval_mate=row.eval_mate,
            best_move_uci=row.best_move_uci,
            pv_uci=row.pv_uci,
            multipv_rank=row.multipv_rank,
            engine=row.engine,
        )
    # Clients hydrate by the exact FEN they requested, while persistence uses
    # four-field keys. Multiple counter variants share one database reading.
    return {
        requested: evaluations[normalized]
        for requested, normalized in lookup_fens.items()
        if normalized in evaluations
    }


@router.post("/explain", response_model=list[MoveExplanationOut])
async def explain_moves(payload: MoveExplanationsIn) -> list[MoveExplanationOut]:
    """Why each costly move in a review cost what it did, in board terms."""
    return [explained for item in payload.items if (explained := _explain(item)) is not None]
