from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.position import Position
from app.services.analysis import get_analysis_for_position
from app.routers.analysis import get_position_analysis


@pytest.mark.asyncio
@pytest.mark.parametrize("depth,expected", [(None, [(22, 1), (22, 2)]), (20, [(20, 1)]), (31, [])])
async def test_default_analysis_uses_deepest_primary_not_deepest_alternative(depth, expected):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine)() as session:
            session.add(Position(id=1, fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"))
            for row_depth, rank in [(20, 1), (22, 1), (22, 2), (24, 2)]:
                session.add(AnalysisResult(
                    position_id=1, depth=row_depth, multipv_rank=rank,
                    eval_cp=20, best_move_uci="e2e4", best_move_san="e4",
                ))
            await session.commit()
            rows = await get_analysis_for_position(session, 1, depth)
            assert [(row.depth, row.multipv_rank) for row in rows] == expected
            full_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
            response = await get_position_analysis(fen=full_fen, depth=depth, session=session)
            assert [(row.depth, row.multipv_rank) for row in response] == expected
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_secondary_only_analysis_does_not_impersonate_a_primary_line():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine)() as session:
            session.add(Position(id=1, fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"))
            session.add(AnalysisResult(
                position_id=1, depth=24, multipv_rank=2,
                eval_cp=20, best_move_uci="d2d4", best_move_san="d4",
            ))
            await session.commit()
            assert await get_analysis_for_position(session, 1) == []
    finally:
        await engine.dispose()
