from uuid import uuid4
import asyncio
import importlib.util
import os
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, func, inspect, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.analysis import AnalysisResult
from app.models.drill_progress import DrillAttempt, DrillProgress
from app.models.position import Position
from app.schemas.improvement import DrillAttemptIn
from app.services.improvement import record_drill_attempt
from app.database import engine as configured_engine

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"


def test_receipt_migration_preserves_legacy_attempts(monkeypatch):
    path = Path(__file__).parents[1] / "alembic/versions/016_drill_attempt_receipts.py"
    spec = importlib.util.spec_from_file_location("receipt_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE drill_attempts (id INTEGER PRIMARY KEY, username TEXT, position_id INTEGER, correct INTEGER)"))
            connection.execute(text("INSERT INTO drill_attempts VALUES (1, 'legacy', 7, 1), (2, 'legacy', 7, 0)"))
            monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
            migration.upgrade()
            assert connection.execute(text("SELECT id, correct, request_id, result_snapshot FROM drill_attempts ORDER BY id")).all() == [
                (1, 1, None, None), (2, 0, None, None),
            ]
            assert any(index["name"] == "uq_drill_attempt_request" and index["unique"]
                       for index in inspect(connection).get_indexes("drill_attempts"))
            migration.downgrade()
            assert connection.execute(text("SELECT * FROM drill_attempts ORDER BY id")).all() == [
                (1, "legacy", 7, 1), (2, "legacy", 7, 0),
            ]
    finally:
        engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("played", ["e2e4", "g1f3"])
async def test_answer_retry_returns_original_receipt_without_regrading(played):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as session:
            session.add(Position(id=1, fen=START))
            session.add(AnalysisResult(position_id=1, depth=22, eval_cp=20,
                                       best_move_uci="e2e4", best_move_san="e4"))
            await session.commit()
        payload = DrillAttemptIn(request_id=uuid4(), username="receipt", position_id=1,
                                 expected_move_uci="e2e4", played_move_uci=played,
                                 pattern_key="opening_decision", response_ms=1000)
        async with sessions() as session:
            original = await record_drill_attempt(session, payload)
            await session.commit()
        # The response was lost. Meanwhile a new search changes the expected move.
        async with sessions() as session:
            analysis = await session.scalar(select(AnalysisResult))
            analysis.best_move_uci = "d2d4"
            await session.commit()
        async with sessions() as session:
            retry = await record_drill_attempt(session, payload)
            assert retry == original
            case_retry = await record_drill_attempt(session, payload.model_copy(update={"username": payload.username.upper()}))
            assert case_retry == original
            assert (await session.scalar(select(DrillProgress))).attempts == 1
            assert await session.scalar(select(func.count()).select_from(DrillAttempt)) == 1
            with pytest.raises(ValueError, match="request ID"):
                await record_drill_attempt(session, payload.model_copy(update={"played_move_uci": "d2d4"}))
            # Different intentional attempts still require current evidence.
            with pytest.raises(ValueError, match="expected move is stale"):
                await record_drill_attempt(session, payload.model_copy(update={"request_id": uuid4()}))
            next_attempt = payload.model_copy(update={
                "request_id": uuid4(), "expected_move_uci": "d2d4", "played_move_uci": "d2d4",
            })
            # A changed engine answer has its own review history.
            assert (await record_drill_attempt(session, next_attempt)).attempts == 1
            await session.commit()
            assert await session.scalar(select(func.count()).select_from(DrillAttempt)) == 2
            intentional_retry = next_attempt.model_copy(update={"request_id": uuid4()})
            assert (await record_drill_attempt(session, intentional_retry)).attempts == 2
            await session.commit()
            assert await record_drill_attempt(session, payload) == original
            assert await session.scalar(select(func.count()).select_from(DrillAttempt)) == 3
    finally:
        await engine.dispose()


@pytest.mark.asyncio
@pytest.mark.skipif(os.environ.get("CHESSGOD_TEST_POSTGRES") != "1", reason="Requires isolated PostgreSQL schema")
async def test_overlapping_answer_retries_record_one_attempt():
    schema = "chessgod_receipt_test_" + uuid4().hex
    engine = create_async_engine(configured_engine.url)
    scoped = engine.execution_options(schema_translate_map={None: schema})
    sessions = async_sessionmaker(scoped, expire_on_commit=False)
    try:
        async with engine.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        async with scoped.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as session:
            session.add(Position(id=1, fen=START))
            await session.flush()
            session.add(AnalysisResult(position_id=1, depth=22, eval_cp=20,
                                       best_move_uci="e2e4", best_move_san="e4"))
            await session.commit()
        payload = DrillAttemptIn(request_id=uuid4(), username="parallel", position_id=1,
                                 expected_move_uci="e2e4", played_move_uci="e2e4",
                                 pattern_key="opening_decision")

        async def submit():
            async with sessions() as session:
                result = await record_drill_attempt(session, payload)
                await session.commit()
                return result

        results = await asyncio.wait_for(asyncio.gather(submit(), submit(), submit()), timeout=15)
        assert results[0] == results[1] == results[2]
        async with sessions() as session:
            assert await session.scalar(select(func.count()).select_from(DrillAttempt)) == 1
            assert (await session.scalar(select(DrillProgress))).attempts == 1
    finally:
        # This invocation owns this exact temporary schema and its test rows.
        async with engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await engine.dispose()
