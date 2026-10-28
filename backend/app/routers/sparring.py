"""Games played against the engine opponent: history, and mistakes to drill."""

from __future__ import annotations

import chess
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, func, select
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.analysis import AnalysisResult
from app.models.position import Position
from app.models.sparring import SparringGame, SparringMistake
from app.routers.improvement import invalidate_plan
from app.schemas.analysis import AnalysisEvaluationItemIn
from app.schemas.sparring import (
    SparringGameCreated,
    SparringGameIn,
    SparringGameOut,
    SparringHistoryOut,
    SparringMistakeIn,
    SparringMistakesIn,
    SparringMistakesStored,
    SparringSummaryOut,
)
from app.utils.fen import normalize_fen
from app.services import training

router = APIRouter()


def _board(fen: str) -> chess.Board:
    parts = fen.split()
    while len(parts) < 6:
        parts.append("0" if len(parts) == 4 else "1")
    try:
        return chess.Board(" ".join(parts))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Not a legal position: {fen}") from exc


def _legal(board: chess.Board, uci: str | None) -> bool:
    if not uci:
        return False
    try:
        return chess.Move.from_uci(uci) in board.legal_moves
    except ValueError:
        return False


async def _store_evidence(
    session: AsyncSession, position_id: int, fen: str, mistake: SparringMistakeIn
) -> None:
    """Keep the review's line for a mistake's position, validated like any upload."""
    try:
        item = AnalysisEvaluationItemIn(
            fen=fen,
            depth=mistake.depth,
            eval_cp=None if mistake.parent_eval_mate is not None else mistake.parent_eval_cp,
            eval_mate=mistake.parent_eval_mate,
            best_move_uci=mistake.best_move_uci,
            pv_uci=mistake.best_pv_uci or mistake.best_move_uci,
        )
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=f"Unusable line for {fen}") from exc
    exists = await session.scalar(
        select(AnalysisResult.id).where(
            AnalysisResult.position_id == position_id,
            AnalysisResult.engine == item.engine,
            AnalysisResult.multipv_rank == 1,
            AnalysisResult.depth == item.depth,
        )
    )
    if exists is not None:
        return
    session.add(AnalysisResult(
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
        multipv_rank=1,
    ))


@router.post("/games", response_model=SparringGameCreated)
async def save_game(
    payload: SparringGameIn, session: AsyncSession = Depends(get_db)
) -> SparringGameCreated:
    board = _board(payload.start_fen)
    for uci in payload.moves_uci:
        if not _legal(board, uci):
            raise HTTPException(status_code=422, detail=f"Illegal move in the game: {uci}")
        board.push_uci(uci)
    game = SparringGame(
        username=payload.username,
        user_color=payload.user_color,
        engine_rating=payload.engine_rating,
        rated=payload.rated,
        result=payload.result,
        reason=payload.reason,
        start_fen=normalize_fen(payload.start_fen),
        moves_uci=" ".join(payload.moves_uci),
        time_control_seconds=payload.time_control_seconds,
    )
    session.add(game)
    await session.flush()
    xp = await training.award(session, payload.username, "sparring_game",
                              detail={"result": payload.result}, request_id=f"sparring:{game.id}")
    if payload.origin and payload.origin.startswith("boss:"):
        # A draw from a line's end is holding the position; that counts as beating it.
        beaten = payload.result in ("win", "draw")
        xp += await training.award(
            session, payload.username, "boss_defeated" if beaten else "boss_fought",
            detail={"line_id": payload.origin.removeprefix("boss:"), "result": payload.result},
            request_id=f"boss:{game.id}",
        )
    await training.settle_quests(session, payload.username, tz=payload.tz)
    await session.commit()
    return SparringGameCreated(id=game.id, xp_gained=xp)


@router.post("/games/{game_id}/mistakes", response_model=SparringMistakesStored)
async def save_mistakes(
    game_id: int, payload: SparringMistakesIn, session: AsyncSession = Depends(get_db)
) -> SparringMistakesStored:
    game = await session.get(SparringGame, game_id)
    if game is None:
        raise HTTPException(status_code=404, detail="No such game")
    # Replaced wholesale: posting the same review twice must not double the drills.
    await session.execute(delete(SparringMistake).where(SparringMistake.game_id == game_id))
    for mistake in payload.mistakes:
        fen = normalize_fen(mistake.fen)
        board = _board(fen)
        if not _legal(board, mistake.user_move_uci) or not _legal(board, mistake.best_move_uci):
            raise HTTPException(status_code=422, detail=f"Illegal move for {fen}")
        position_id = await session.scalar(select(Position.id).where(Position.fen == fen))
        if position_id is None:
            position = Position(fen=fen)
            session.add(position)
            await session.flush()
            position_id = position.id
        await _store_evidence(session, position_id, fen, mistake)
        session.add(SparringMistake(
            game_id=game_id,
            position_id=position_id,
            ply=mistake.ply,
            user_move_uci=mistake.user_move_uci,
            user_move_san=mistake.user_move_san,
            best_move_uci=mistake.best_move_uci,
            best_pv_uci=mistake.best_pv_uci,
            reply_pv_uci=mistake.reply_pv_uci,
            previous_move_uci=mistake.previous_move_uci,
            parent_eval_cp=mistake.parent_eval_cp,
            parent_eval_mate=mistake.parent_eval_mate,
            eval_drop_cp=mistake.eval_drop_cp,
        ))
    await session.commit()
    # New drills: the next plan read rebuilds rather than serving the last one.
    await invalidate_plan(game.username)
    return SparringMistakesStored(stored=len(payload.mistakes))


@router.get("/games", response_model=SparringHistoryOut)
async def history(
    username: str = Query(..., min_length=1, max_length=64),
    limit: int = Query(20, ge=1, le=100),
    session: AsyncSession = Depends(get_db),
) -> SparringHistoryOut:
    mistakes = (
        select(SparringMistake.game_id, func.count().label("n"))
        .group_by(SparringMistake.game_id)
        .subquery()
    )
    rows = (await session.execute(
        select(SparringGame, func.coalesce(mistakes.c.n, 0))
        .outerjoin(mistakes, mistakes.c.game_id == SparringGame.id)
        .where(SparringGame.username == username)
        .order_by(SparringGame.played_at.desc(), SparringGame.id.desc())
        .limit(limit)
    )).all()
    counts = dict((await session.execute(
        select(SparringGame.result, func.count())
        .where(SparringGame.username == username)
        .group_by(SparringGame.result)
    )).all())
    rated = (await session.execute(
        select(SparringGame.engine_rating)
        .where(SparringGame.username == username, SparringGame.rated.is_(True))
        .order_by(SparringGame.played_at.asc(), SparringGame.id.asc())
    )).scalars().all()
    return SparringHistoryOut(
        summary=SparringSummaryOut(
            played=sum(counts.values()),
            wins=counts.get("win", 0),
            draws=counts.get("draw", 0),
            losses=counts.get("loss", 0),
            rated_played=len(rated),
            first_rating=rated[0] if rated else None,
            latest_rating=rated[-1] if rated else None,
        ),
        games=[
            SparringGameOut(
                id=game.id,
                user_color=game.user_color,
                engine_rating=game.engine_rating,
                rated=game.rated,
                result=game.result,
                reason=game.reason,
                moves=len(game.moves_uci.split()) if game.moves_uci else 0,
                mistakes=int(count),
                time_control_seconds=game.time_control_seconds,
                played_at=game.played_at,
                start_fen=game.start_fen,
                moves_uci=game.moves_uci.split() if game.moves_uci else [],
            )
            for game, count in rows
        ],
    )
