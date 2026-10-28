from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

engine = create_async_engine(
    settings.database_url,
    echo=False,
    pool_pre_ping=True,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_recycle=settings.db_pool_recycle_seconds,
)
async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


def pool_stats() -> dict[str, Any]:
    pool = engine.pool
    stats: dict[str, Any] = {}
    for attr in ("size", "checkedin", "checkedout", "overflow"):
        accessor = getattr(pool, attr, None)
        if callable(accessor):
            try:
                stats[attr] = accessor()
            except Exception:
                continue
    status = getattr(pool, "status", None)
    if callable(status):
        try:
            stats["status"] = status()
        except Exception:
            pass
    return stats
