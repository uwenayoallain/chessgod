from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.import_job import ImportJob
from app.models.training import TrainingEvent
from app.services import auto_sync

NOW = datetime(2026, 9, 30, 12, tzinfo=UTC)
HOUR = timedelta(hours=1)


def test_a_failed_sync_is_retried_sooner_than_a_good_one() -> None:
    interval = 3 * HOUR
    assert auto_sync.due(None, NOW, interval)
    assert not auto_sync.due((NOW - 2 * HOUR, True), NOW, interval)
    assert auto_sync.due((NOW - 3 * HOUR, True), NOW, interval)
    assert auto_sync.due((NOW - timedelta(minutes=31), False), NOW, interval)
    assert not auto_sync.due((NOW - timedelta(minutes=10), False), NOW, interval)


@pytest.mark.asyncio
async def test_only_players_imported_or_trained_with_lately_are_synced() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add_all([
            ImportJob(id="a", username="saint_uwe", status="error", created_at=NOW - timedelta(days=17)),
            # Imported once, long ago, to look at: left alone.
            ImportJob(id="b", username="hikaru", status="complete", created_at=NOW - timedelta(days=200)),
            TrainingEvent(username="Trainee", kind="quiz_answer", xp=1, created_at=NOW - timedelta(days=2)),
            TrainingEvent(username="old_trainee", kind="quiz_answer", xp=1, created_at=NOW - timedelta(days=60)),
        ])
        await session.commit()
        players = await auto_sync.sync_candidates(session, NOW)
    await engine.dispose()
    assert players == ["trainee", "saint_uwe"]
