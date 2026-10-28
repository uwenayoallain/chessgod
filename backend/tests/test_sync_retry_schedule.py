from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.external_sync_state import ExternalSyncState
from app.services.master_openings import LICHESS_SYNC_PROVIDER, seconds_until_sync_retry


async def _session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    return async_sessionmaker(engine, expire_on_commit=False)()


@pytest.mark.asyncio
async def test_no_cooldown_leaves_the_normal_interval_alone() -> None:
    async with await _session() as session:
        assert await seconds_until_sync_retry(session) is None


@pytest.mark.asyncio
async def test_a_pending_cooldown_is_what_the_loop_waits_for() -> None:
    """A 429 pause must not be swallowed by the six-hour interval.

    The explorer 429s after about twenty requests, so most runs end in a
    cooldown. Sleeping the full interval afterwards capped master data at one
    short burst per six hours -- roughly 23 positions -- no matter how brief the
    cooldown was.
    """
    async with await _session() as session:
        session.add(ExternalSyncState(
            provider=LICHESS_SYNC_PROVIDER,
            cooldown_until=datetime.now(UTC) + timedelta(seconds=60),
        ))
        await session.commit()

        retry_in = await seconds_until_sync_retry(session)

        assert retry_in is not None
        assert 55 <= retry_in <= 62


@pytest.mark.asyncio
async def test_an_expired_cooldown_does_not_delay_the_next_run() -> None:
    async with await _session() as session:
        session.add(ExternalSyncState(
            provider=LICHESS_SYNC_PROVIDER,
            cooldown_until=datetime.now(UTC) - timedelta(minutes=5),
        ))
        await session.commit()

        assert await seconds_until_sync_retry(session) is None
