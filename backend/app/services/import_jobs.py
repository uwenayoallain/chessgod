"""Durable import status: independent readers, replay and cross-worker locking."""
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session_factory
from app.models.import_job import ImportEvent, ImportJob
from app.services.game_ingest import _insert_for_session


class ImportJobInactive(RuntimeError):
    pass


async def guard_import_commit(session: AsyncSession, job_id: str) -> None:
    """Fence a replaced/expired worker before it commits an archive."""
    active = await session.scalar(select(ImportJob.id).where(
        ImportJob.id == job_id, ImportJob.status == "running",
    ).with_for_update())
    if active is None:
        raise ImportJobInactive("Import job is no longer active")


async def expire_stale_import_jobs(session: AsyncSession, username: str) -> None:
    # A crashed process cannot leave the player locked out indefinitely.
    expired = list(await session.scalars(select(ImportJob.id).where(
        ImportJob.username == username, ImportJob.status == "running",
        ImportJob.updated_at < datetime.now(UTC) - timedelta(minutes=10),
    ).with_for_update()))
    for job_id in expired:
        await append_import_event(session, job_id, {"type": "error", "message": "Import interrupted; please retry."})


async def create_import_job(session: AsyncSession, username: str) -> str | None:
    username = username.lower()
    await expire_stale_import_jobs(session, username)
    job_id = str(uuid4())
    stmt = _insert_for_session(session)(ImportJob).values(id=job_id, username=username, status="running")
    return await session.scalar(stmt.on_conflict_do_nothing().returning(ImportJob.id))


async def append_import_event(session: AsyncSession, job_id: str, payload: dict) -> bool:
    status = payload.get("type")
    changed = await session.scalar(update(ImportJob).where(
        ImportJob.id == job_id, ImportJob.status == "running",
    ).values(updated_at=datetime.now(UTC), status=status if status in {"complete", "error"} else "running")
      .returning(ImportJob.id))
    if changed is None:
        return False
    session.add(ImportEvent(job_id=job_id, payload=payload))
    await session.flush()
    return True


class ImportEventPublisher:
    def __init__(self, job_id: str):
        self.job_id = job_id

    async def put(self, event: dict) -> None:
        async with async_session_factory() as session:
            if not await append_import_event(session, self.job_id, event):
                raise ImportJobInactive("Import job is no longer active")
            await session.commit()
