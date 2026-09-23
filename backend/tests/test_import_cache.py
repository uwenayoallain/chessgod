import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.import_archive import ImportArchive
from app.services.import_cache import mark_archive_cached, should_fetch_archive


def _previous_month(year: int, month: int) -> tuple[int, int]:
    if month == 1:
        return year - 1, 12
    return year, month - 1


@pytest.mark.asyncio
async def test_should_fetch_archive_when_no_cache_record_exists() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        assert await should_fetch_archive(
            session, "hikaru", "https://api.chess.com/pub/player/hikaru/games/2024/03"
        )

    await engine.dispose()


@pytest.mark.asyncio
async def test_cached_archive_skips_refetch_unless_forced() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    archive_url = "https://api.chess.com/pub/player/hikaru/games/2024/03"

    async with session_factory() as session:
        await mark_archive_cached(
            session,
            username="hikaru",
            archive_url=archive_url,
            games_in_archive=87,
        )
        await session.commit()

        cached = await session.scalar(
            select(ImportArchive).where(ImportArchive.archive_url == archive_url)
        )
        assert cached is not None and cached.games_in_archive == 87
        assert not await should_fetch_archive(session, "hikaru", archive_url)
        assert await should_fetch_archive(session, "hikaru", archive_url, force=True)
        cached.ownership_version = 0
        await session.flush()
        assert await should_fetch_archive(session, "HIKARU", archive_url)
        await mark_archive_cached(session, "HIKARU", archive_url, 87)
        await session.commit()
        assert not await should_fetch_archive(session, "HIKARU", archive_url)
        assert len(list(await session.scalars(select(ImportArchive)))) == 1

    await engine.dispose()


@pytest.mark.asyncio
async def test_cached_recent_archives_are_refetched_without_force() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    from datetime import UTC, datetime

    now = datetime.now(UTC)
    current_url = (
        f"https://api.chess.com/pub/player/hikaru/games/{now.year:04d}/{now.month:02d}"
    )
    prev_year, prev_month = _previous_month(now.year, now.month)
    previous_url = f"https://api.chess.com/pub/player/hikaru/games/{prev_year:04d}/{prev_month:02d}"

    async with session_factory() as session:
        await mark_archive_cached(
            session,
            username="hikaru",
            archive_url=current_url,
            games_in_archive=10,
        )
        await mark_archive_cached(
            session,
            username="hikaru",
            archive_url=previous_url,
            games_in_archive=12,
        )
        await session.commit()

        assert await should_fetch_archive(session, "hikaru", current_url)
        assert await should_fetch_archive(session, "hikaru", previous_url)

    await engine.dispose()
