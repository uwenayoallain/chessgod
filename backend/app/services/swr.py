"""Serve the last known answer while one rebuild follows new evidence."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from hashlib import sha256
from typing import Any

from redis.exceptions import RedisError, WatchError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.database import _async_engine_for
from app.services.cache import SharedCache, get_shared_cache

logger = logging.getLogger(__name__)

Compute = Callable[[AsyncSession], Awaitable[Any]]

_refreshes: dict[tuple[str, str], asyncio.Task[Any]] = {}


def _generation_prefixes(key: str) -> list[str]:
    key = key.lower()
    return [key[:index + 1] for index, char in enumerate(key) if char == ":"] + [key]


async def _publish(
    cache: SharedCache,
    fresh_base: str,
    fresh_key: str,
    last_key: str,
    last_generation: str,
    value: Any,
    fresh_ttl: float,
    last_ttl: float,
) -> None:
    redis = cache._redis
    if redis is None:
        # Local cache operations complete without yielding to invalidation.
        if (
            fresh_key == await cache.versioned_key(fresh_base)
            and last_generation == await cache.versioned_key(last_key)
        ):
            await cache.set_json(fresh_key, value, ttl_seconds=fresh_ttl)
            await cache.set_json(last_key, value, ttl_seconds=last_ttl)
        return

    # WATCH closes the race between the generation check and publication on
    # Redis, including invalidation by another worker. Read the same fields
    # as SharedCache.versioned_key on the watched connection, so a Redis
    # connection failure cannot substitute a local generation for publication.
    fresh_prefixes = _generation_prefixes(fresh_base)
    last_prefixes = _generation_prefixes(last_key)
    prefixes = list(dict.fromkeys([*fresh_prefixes, *last_prefixes]))

    def matches(key: str, key_prefixes: list[str], generations: dict) -> bool:
        token = json.dumps([generations[prefix] for prefix in key_prefixes])
        return key.endswith(":generation:" + sha256(token.encode()).hexdigest()[:24])

    try:
        raw = json.dumps(value)
        while True:
            try:
                async with redis.pipeline() as pipe:
                    await pipe.watch("cache:generations")
                    values = await pipe.hmget("cache:generations", prefixes)
                    generations = dict(zip(prefixes, values, strict=True))
                    if not (
                        matches(fresh_key, fresh_prefixes, generations)
                        and matches(last_generation, last_prefixes, generations)
                    ):
                        return
                    pipe.multi()
                    pipe.set(fresh_key, raw, ex=max(1, int(fresh_ttl)))
                    pipe.set(last_key, raw, ex=max(1, int(last_ttl)))
                    await pipe.execute()
                    return
            except WatchError:
                continue
    except RedisError:
        logger.debug("Could not publish cache refresh for %s", fresh_base, exc_info=True)


async def stale_while_revalidate(
    session: AsyncSession,
    *,
    fresh_base: str,
    last_key: str,
    compute: Compute,
    fresh_ttl: float,
    last_ttl: float = 86_400.0,
    force_refresh: bool = False,
    session_factory: Callable[[], AbstractAsyncContextManager[AsyncSession]] | None = None,
) -> Any:
    """Reuse an in-flight build and serve the stale result when available."""
    cache = get_shared_cache()
    last_key = last_key.lower()
    if force_refresh:
        # Upload invalidation can be deferred. Fence any earlier build that
        # still holds the current generation before reading new evidence.
        await cache.delete_prefix(fresh_base, versioned_only=True)
    fresh_key = await cache.versioned_key(fresh_base)
    if not force_refresh:
        cached = await cache.get_json(fresh_key)
        if cached is not None:
            return cached
    last_generation = await cache.versioned_key(last_key)

    async def build(db: AsyncSession) -> Any:
        # A prior flight may have published since this reader looked the key up.
        if not force_refresh:
            cached = await cache.get_json(fresh_key)
            if cached is not None:
                return cached
        value = await compute(db)
        await _publish(
            cache, fresh_base, fresh_key, last_key, last_generation,
            value, fresh_ttl, last_ttl,
        )
        return value

    if force_refresh:
        return await build(session)

    if session_factory is None:
        engine = _async_engine_for(session)
        if engine is None:
            return await build(session)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)

    last = await cache.get_json(last_key)
    flight_key = (fresh_key, last_generation)
    running = _refreshes.get(flight_key)
    if running is not None:
        return last if last is not None else await asyncio.shield(running)

    async def refresh() -> Any:
        async with session_factory() as db:
            return await build(db)

    def finished(task: asyncio.Task[Any]) -> None:
        if _refreshes.get(flight_key) is task:
            del _refreshes[flight_key]
        if not task.cancelled() and (error := task.exception()) is not None:
            logger.warning("Background refresh of %s failed", last_key, exc_info=error)

    task = _refreshes[flight_key] = asyncio.create_task(refresh())
    task.add_done_callback(finished)
    return last if last is not None else await asyncio.shield(task)
