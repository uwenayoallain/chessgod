from __future__ import annotations

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.position import Position
from app.routers.analysis import get_evaluations
from app.routers.analysis import store_evaluations
from app.schemas.analysis import AnalysisEvaluationBatchIn, AnalysisEvaluationItemIn


@pytest.mark.asyncio
async def test_bulk_lookup_normalizes_counters_but_preserves_requested_keys():
    fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"
    full = f"{fen} 0 1"
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine)() as session:
            session.add(Position(id=1, fen=fen))
            session.add(AnalysisResult(position_id=1, depth=22, eval_cp=30,
                                       best_move_uci="e2e4", best_move_san="e4"))
            await session.commit()
            results = await get_evaluations(fens=f"{full},{fen},{full}", min_depth=18, session=session)
            assert set(results) == {full, fen}
            assert results[full] == results[fen]
            assert results[full].depth == 22
            assert await get_evaluations(fens=full, min_depth=24, session=session) == {}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_bulk_hydration_loads_only_one_trusted_primary_per_position():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    loaded: list[int] = []

    def track_load(row, _context):
        loaded.append(row.id)

    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine)
        async with factory() as session:
            for position_id in range(1, 4):
                session.add(Position(id=position_id, fen=f"position-{position_id}"))
                for depth in range(18, 65):
                    session.add(AnalysisResult(
                        position_id=position_id, depth=depth, multipv_rank=1,
                        eval_cp=depth, best_move_uci="e2e4", best_move_san="e4",
                    ))
                session.add(AnalysisResult(
                    position_id=position_id, depth=100, multipv_rank=2,
                    eval_cp=0, best_move_uci="d2d4", best_move_san="d4",
                ))
                # A superseded contract version used to be inserted here to
                # prove it was filtered out on read. Since migration 018 the
                # engine contract is a CHECK constraint, so such a row cannot be
                # stored at all — see
                # test_another_engines_evaluation_cannot_be_stored_alongside_the_contract.
            await session.commit()
        event.listen(AnalysisResult, "load", track_load)
        async with factory() as session:
            result = await get_evaluations(
                fens="position-1,position-2,missing", min_depth=18, session=session,
            )
        assert set(result) == {"position-1", "position-2"}
        assert all(row.depth == 64 and row.eval_cp == 64 for row in result.values())
        assert len(loaded) == 2
    finally:
        if event.contains(AnalysisResult, "load", track_load):
            event.remove(AnalysisResult, "load", track_load)
        await engine.dispose()


@pytest.mark.asyncio
async def test_upload_loads_only_requested_depth_rows(monkeypatch):
    from unittest.mock import AsyncMock
    import app.routers.analysis as router
    monkeypatch.setattr(router, "invalidate_improvement_caches_for_positions", AsyncMock())
    fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    loaded = []
    def track(row, _context):
        loaded.append(row.id)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine)
        async with factory() as session:
            session.add(Position(id=1, fen=fen))
            for rank in (1, 2, 3):
                for depth in range(18, 41):
                    session.add(AnalysisResult(position_id=1, depth=depth, multipv_rank=rank,
                        eval_cp=20, best_move_uci="e2e4", best_move_san="e4", pv_uci="e2e4", pv_san="e4"))
            await session.commit()
        event.listen(AnalysisResult, "load", track)
        async with factory() as session:
            payload = AnalysisEvaluationBatchIn(items=[
                AnalysisEvaluationItemIn(fen=fen, depth=depth, eval_cp=20, best_move_uci="e2e4")
                for depth in (22, 41, 21)
            ])
            result = await store_evaluations(payload, session=session)
            assert result == {"stored": 1, "skipped": 2, "upgraded": 1}
            assert len(loaded) == 2
    finally:
        if event.contains(AnalysisResult, "load", track):
            event.remove(AnalysisResult, "load", track)
        await engine.dispose()
