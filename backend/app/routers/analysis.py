from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.analysis import AnalysisResult
from app.models.position import Position
from app.schemas.analysis import AnalysisResultIn, AnalysisResultOut, RecurringMistakeOut
from app.services.analysis import get_analysis_for_position

router = APIRouter()


@router.get("/position", response_model=list[AnalysisResultOut])
async def get_position_analysis(
    fen: str = Query(...),
    depth: int | None = None,
    session: AsyncSession = Depends(get_db),
) -> list[AnalysisResultOut]:
    position = await session.scalar(select(Position).where(Position.fen == fen))
    if position is None:
        return []
    rows = await get_analysis_for_position(session, position.id, depth)
    return [AnalysisResultOut.model_validate(row, from_attributes=True) for row in rows]


@router.post("/position")
async def store_position_analysis(
    payload: AnalysisResultIn,
    session: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    position = await session.scalar(select(Position).where(Position.fen == payload.fen))
    if position is None:
        raise HTTPException(status_code=404, detail="Position not found")

    stored = 0
    for line in payload.lines:
        session.add(
            AnalysisResult(
                position_id=position.id,
                engine=payload.engine,
                engine_version=payload.engine_version,
                depth=payload.depth,
                eval_cp=line.eval_cp,
                eval_mate=line.eval_mate,
                best_move_uci=line.best_move_uci,
                best_move_san=line.best_move_san,
                pv_uci=line.pv_uci,
                pv_san=line.pv_san,
                multipv_rank=line.multipv_rank,
            )
        )
        stored += 1
    return {"stored": stored}


@router.get("/deviations")
async def analysis_deviations() -> list[dict]:
    return []


@router.get("/mistakes", response_model=list[RecurringMistakeOut])
async def recurring_mistakes() -> list[RecurringMistakeOut]:
    return []
