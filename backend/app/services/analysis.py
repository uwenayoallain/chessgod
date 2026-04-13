from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analysis import AnalysisResult


async def get_analysis_for_position(session: AsyncSession, position_id: int, depth: int | None = None) -> list[AnalysisResult]:
    stmt = select(AnalysisResult).where(AnalysisResult.position_id == position_id)
    if depth is not None:
        stmt = stmt.where(AnalysisResult.depth == depth)
    stmt = stmt.order_by(AnalysisResult.depth.desc(), AnalysisResult.multipv_rank.asc())
    result = await session.execute(stmt)
    return list(result.scalars().all())
