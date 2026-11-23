"""Serve the last known answer at once and rebuild it behind the reader.

A result cached under the evidence generation goes cold on every upload, and
the crawler uploads about every forty seconds, so most reads of a slow
surface would pay the full rebuild. Each entry is therefore kept twice: a
fresh copy under the generation, and a last-known copy without it. A fresh
hit is served; a stale read serves the last-known copy and starts one
background rebuild; only a reader with neither waits.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session_factory
from app.services.cache import get_shared_cache

logger = logging.getLogger(__name__)

Compute = Callable[[AsyncSession], Awaitable[Any]]

_refreshes: dict[str, asyncio.Task[None]] = {}


async def _build_and_store(
    session: AsyncSession, fresh_base: str, last_key: str, compute: Compute,
    fresh_ttl: float, last_ttl: float,
) -> Any:
    cache = get_shared_cache()
    # Captured before reading, so a result computed across an upload is filed
    # under the generation it actually saw.
    fresh_key = await cache.versioned_key(fresh_base)
    value = await compute(session)
    await cache.set_json(fresh_key, value, ttl_seconds=fresh_ttl)
    await cache.set_json(last_key, value, ttl_seconds=last_ttl)
    return value


def _refresh_in_background(
    fresh_base: str, last_key: str, compute: Compute, fresh_ttl: float, last_ttl: float,
) -> None:
    running = _refreshes.get(last_key)
    if running is not None and not running.done():
        return

    async def refresh() -> None:
        try:
            async with async_session_factory() as session:
                await _build_and_store(session, fresh_base, last_key, compute, fresh_ttl, last_ttl)
        except Exception:
            logger.warning("Background refresh of %s failed", last_key, exc_info=True)

    _refreshes[last_key] = asyncio.create_task(refresh())


async def stale_while_revalidate(
    session: AsyncSession,
    *,
    fresh_base: str,
    last_key: str,
    compute: Compute,
    fresh_ttl: float,
    last_ttl: float = 86_400.0,
) -> Any:
    """The JSON value for `fresh_base`, never waiting on a rebuild it can avoid."""
    cache = get_shared_cache()
    cached = await cache.get_json(await cache.versioned_key(fresh_base))
    if cached is not None:
        return cached
    last = await cache.get_json(last_key.lower())
    if last is not None:
        _refresh_in_background(fresh_base, last_key.lower(), compute, fresh_ttl, last_ttl)
        return last
    return await _build_and_store(session, fresh_base, last_key.lower(), compute, fresh_ttl, last_ttl)
