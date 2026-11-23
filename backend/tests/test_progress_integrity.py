from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.position import Position
from app.models.drill_progress import DrillAttempt, DrillProgress
from app.services.progress_integrity import audit_progress


@pytest.mark.asyncio
async def test_progress_audit_detects_counter_receipt_and_orphan_errors_without_crossing_users():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine)() as session:
            for pid in (1, 2):
                session.add(Position(id=pid, fen=f"position-{pid}"))
            session.add(DrillProgress(
                username="tester", position_id=1, expected_move_uci="e2e4",
                attempts=2, correct_attempts=2, streak=3, interval_days=1,
                due_at=datetime.now(UTC),
            ))
            for username, pid in [("tester", 1), ("tester", 2), ("other", 2)]:
                session.add(DrillAttempt(
                    username=username, position_id=pid, expected_move_uci="e2e4",
                    played_move_uci="e2e4", pattern_key="calculation", correct=1,
                    request_id=f"request-{username}-{pid}", result_snapshot=None,
                ))
            await session.commit()
            assert await audit_progress(session, "tester") == {
                "progress_rows_checked": 1, "tracked_attempts": 2,
                "attempt_count_mismatches": 1, "invalid_progress_counters": 1,
                "invalid_review_schedules": 0,
                "attempt_groups_missing_progress": 1, "idempotent_attempts_missing_receipts": 2,
            }
            empty = await audit_progress(session, "new-player")
            assert all(value == 0 for value in empty.values())
    finally:
        await engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("interval,ease,invalid", [
    (0, 1.3, 0), (60, 2.8, 0), (-1, 2.0, 1), (61, 2.0, 1),
    (3, 1.0, 1), (3, 3.0, 1), (3, float("inf"), 1),
])
async def test_progress_audit_checks_review_schedule_bounds(interval, ease, invalid):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine)() as session:
            session.add(Position(id=1, fen="position"))
            session.add(DrillProgress(
                username="tester", position_id=1, expected_move_uci="e2e4",
                attempts=0, correct_attempts=0, streak=0, interval_days=interval,
                ease_factor=ease, due_at=datetime.now(UTC),
            ))
            await session.commit()
            result = await audit_progress(session, "tester")
            assert result["invalid_review_schedules"] == invalid
    finally:
        await engine.dispose()
