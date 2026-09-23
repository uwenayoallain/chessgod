from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select, func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.import_archive import ImportArchive


def _upsert_for_session(session: AsyncSession):
    bind = session.bind
    if bind is not None and bind.dialect.name == "sqlite":
        return sqlite_insert
    return pg_insert


def archive_month_from_url(archive_url: str) -> str:
    return "/".join(archive_url.rstrip("/").split("/")[-2:])


def _parse_archive_year_month(archive_url: str) -> tuple[int, int] | None:
    parts = archive_url.rstrip("/").split("/")
    if len(parts) < 2:
        return None
    try:
        year = int(parts[-2])
        month = int(parts[-1])
    except ValueError:
        return None
    if month < 1 or month > 12:
        return None
    return year, month


def _recent_archive_months(now: datetime | None = None) -> set[tuple[int, int]]:
    current = now or datetime.now(UTC)
    current_month = (current.year, current.month)
    previous_month = (
        (current.year - 1, 12)
        if current.month == 1
        else (current.year, current.month - 1)
    )
    return {current_month, previous_month}


async def get_cached_archive(
    session: AsyncSession, username: str, archive_url: str
) -> ImportArchive | None:
    result = await session.execute(
        select(ImportArchive).where(
            ImportArchive.username == username,
            ImportArchive.archive_url == archive_url,
        ).execution_options(populate_existing=True)
    )
    return result.scalar_one_or_none()


async def should_fetch_archive(
    session: AsyncSession,
    username: str,
    archive_url: str,
    force: bool = False,
) -> bool:
    if force:
        return True
    cached_archive = await get_cached_archive(session, username, archive_url)
    if cached_archive is None:
        return True
    if cached_archive.ownership_version < 2:
        return True

    archive_month = _parse_archive_year_month(archive_url)
    if archive_month is None:
        return False

    return archive_month in _recent_archive_months()


async def mark_archive_cached(
    session: AsyncSession,
    username: str,
    archive_url: str,
    games_in_archive: int,
) -> None:
    archive_month = archive_month_from_url(archive_url)
    insert_stmt = _upsert_for_session(session)
    stmt = (
        insert_stmt(ImportArchive)
        .values(
            username=username,
            archive_url=archive_url,
            archive_month=archive_month,
            games_in_archive=games_in_archive,
            ownership_version=2,
        )
        .on_conflict_do_update(
            index_elements=["username", "archive_url"],
            set_={
                "games_in_archive": games_in_archive,
                "ownership_version": 2,
                "fetched_at": func.now(),
            },
        )
    )
    await session.execute(stmt)
