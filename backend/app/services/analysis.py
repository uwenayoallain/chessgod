from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.engine_contract import ENGINE_NAME, ENGINE_VERSION
from app.models.analysis import AnalysisResult


async def get_analysis_for_position(session: AsyncSession, position_id: int, depth: int | None = None) -> list[AnalysisResult]:
    stmt = select(AnalysisResult).where(
        AnalysisResult.position_id == position_id,
        AnalysisResult.engine == ENGINE_NAME,
        AnalysisResult.engine_version == ENGINE_VERSION,
    )
    if depth is not None:
        stmt = stmt.where(AnalysisResult.depth == depth)
    else:
        # An independently deeper secondary variation is not the position's
        # best line. Anchor the snapshot to rank one, and filter in SQL rather
        # than loading all historical depths into the ORM.
        deepest_primary = select(func.max(AnalysisResult.depth)).where(
            AnalysisResult.position_id == position_id,
            AnalysisResult.engine == ENGINE_NAME,
            AnalysisResult.engine_version == ENGINE_VERSION,
            AnalysisResult.multipv_rank == 1,
        ).scalar_subquery()
        stmt = stmt.where(AnalysisResult.depth == deepest_primary)
    stmt = stmt.order_by(AnalysisResult.multipv_rank.asc())
    result = await session.execute(stmt)
    return list(result.scalars().all())
