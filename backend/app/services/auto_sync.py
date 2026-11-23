"""Fetch new games without being asked, while somebody is using the app.

The weekly challenges, the repertoire check and "Are you improving?" are all
measured from imported games, and a library is only as fresh as the last time
somebody pressed Resync. On the first player's library that was 13 September,
and that import had failed on a DNS blip that nothing retried — so for weeks
every one of those surfaces measured a library that had stopped.

Only players somebody imported or trained with recently are synced: a
library imported once to look at (25,191 of hikaru's games) is not re-pulled.
An import only re-reads the current and previous month's archives, so a sync
is a handful of requests. A failed one is retried sooner than a good one.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.import_job import ImportJob
from app.models.training import TrainingEvent

IMPORTED_WITHIN = timedelta(days=90)
TRAINED_WITHIN = timedelta(days=30)
RETRY_AFTER_FAILURE = timedelta(minutes=30)
MAX_PLAYERS = 3


async def sync_candidates(session: AsyncSession, now: datetime) -> list[str]:
    """Players somebody imported or trained with recently, most recent first."""
    imported = (
        await session.execute(
            select(ImportJob.username, ImportJob.created_at).where(ImportJob.created_at >= now - IMPORTED_WITHIN)
        )
    ).all()
    trained = (
        await session.execute(
            select(TrainingEvent.username, TrainingEvent.created_at).where(
                TrainingEvent.created_at >= now - TRAINED_WITHIN
            )
        )
    ).all()
    latest: dict[str, datetime] = {}
    for username, when in [*imported, *trained]:
        when = when if when.tzinfo else when.replace(tzinfo=UTC)
        key = username.lower()
        latest[key] = max(latest.get(key, when), when)
    return [name for name, _ in sorted(latest.items(), key=lambda item: item[1], reverse=True)][:MAX_PLAYERS]


def due(last: tuple[datetime, bool] | None, now: datetime, interval: timedelta) -> bool:
    """Whether a player is due a sync, given when the last one ran and whether it worked."""
    if last is None:
        return True
    when, ok = last
    return now - when >= (interval if ok else min(interval, RETRY_AFTER_FAILURE))
