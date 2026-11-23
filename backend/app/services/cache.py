from __future__ import annotations

import json
import logging
import time
import hashlib
from uuid import uuid4
from collections import OrderedDict
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

try:
    import redis.asyncio as _redis_async
except ImportError:  # pragma: no cover - redis is a hard dependency in prod
    _redis_async = None


class SharedCache:
    """JSON cache backed by Redis, with an in-process fallback.

    Redis keeps the cache shared across uvicorn workers and warm across
    backend restarts. Every operation degrades gracefully: if Redis is not
    configured (tests, bare host dev) or a call fails, a per-process dict with
    the same TTL semantics takes over, so callers never need to care.
    """

    def __init__(self, url: str | None, *, max_entries: int = 128, max_bytes: int = 16 * 1024 * 1024) -> None:
        self._redis = None
        self._local: OrderedDict[str, tuple[float, str, int]] = OrderedDict()
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._local_bytes = 0
        self._generations: dict[str, str] = {}
        self._pending_invalidations: dict[str, str] = {}
        self._generation_epoch = uuid4().hex
        if url and _redis_async is not None:
            self._redis = _redis_async.from_url(
                url,
                decode_responses=True,
                socket_connect_timeout=1.0,
                socket_timeout=1.0,
            )

    async def versioned_key(self, key: str) -> str:
        """Capture invalidation state BEFORE querying the database.

        A calculation finishing after invalidation can only populate its old
        generation; future readers cannot observe that stale result.
        """
        key = key.lower()
        prefixes = [key[:index + 1] for index, char in enumerate(key) if char == ":"] + [key]
        if self._redis is not None:
            try:
                # Redis may have retained entries while an invalidation failed.
                # Publish those generations before trusting its keys again.
                for prefix, generation in list(self._pending_invalidations.items()):
                    await self._redis.hset("cache:generations", prefix, generation)
                    if self._pending_invalidations.get(prefix) == generation:
                        del self._pending_invalidations[prefix]
                generations = await self._redis.hmget("cache:generations", prefixes)
                token = json.dumps(generations)
            except Exception:
                token = self._generation_epoch + json.dumps([self._generations.get(p) for p in prefixes])
        else:
            token = self._generation_epoch + json.dumps([self._generations.get(p) for p in prefixes])
        return key + ":generation:" + hashlib.sha256(token.encode()).hexdigest()[:24]

    async def get_json(self, key: str) -> Any | None:
        if self._redis is not None:
            try:
                raw = await self._redis.get(key)
                return None if raw is None else json.loads(raw)
            except Exception:
                logger.debug("Redis get failed for %s; using local cache", key, exc_info=True)
        entry = self._local.get(key)
        if entry is None:
            return None
        expiry, raw, _ = entry
        if expiry <= time.monotonic():
            self._remove_local(key)
            return None
        self._local.move_to_end(key)
        return json.loads(raw)

    def _remove_local(self, key: str) -> None:
        entry = self._local.pop(key, None)
        if entry is not None:
            self._local_bytes -= entry[2]

    async def set_json(self, key: str, value: Any, *, ttl_seconds: float) -> None:
        raw = json.dumps(value)
        if self._redis is not None:
            try:
                await self._redis.set(key, raw, ex=max(1, int(ttl_seconds)))
                return
            except Exception:
                logger.debug("Redis set failed for %s; using local cache", key, exc_info=True)
        now = time.monotonic()
        for expired in [key for key, (expiry, _, _) in self._local.items() if expiry <= now]:
            self._remove_local(expired)
        self._remove_local(key)
        size = len(raw.encode("utf-8")) + len(key.encode("utf-8"))
        if size > self._max_bytes or self._max_entries <= 0 or ttl_seconds <= 0:
            return
        while self._local and (len(self._local) >= self._max_entries or self._local_bytes + size > self._max_bytes):
            self._remove_local(next(iter(self._local)))
        self._local[key] = (now + ttl_seconds, raw, size)
        self._local_bytes += size

    async def delete_prefix(self, prefix: str, *, versioned_only: bool = False) -> None:
        """Invalidate a prefix; generation-key callers can let old entries expire."""
        prefix = prefix.lower()
        if len(self._generations) >= self._max_entries:
            self._generations.clear()
            self._generation_epoch = uuid4().hex
        generation = uuid4().hex
        self._generations[prefix] = generation
        if self._redis is not None:
            self._pending_invalidations[prefix] = generation
            try:
                await self._redis.hset("cache:generations", prefix, generation)
                if self._pending_invalidations.get(prefix) == generation:
                    del self._pending_invalidations[prefix]
                if not versioned_only:
                    batch: list[str] = []
                    async for key in self._redis.scan_iter(match=f"{prefix}*", count=500):
                        batch.append(key)
                        if len(batch) == 500:
                            await self._redis.delete(*batch)
                            batch.clear()
                    if batch:
                        await self._redis.delete(*batch)
            except Exception:
                logger.debug("Redis delete_prefix failed for %s", prefix, exc_info=True)
        for key in [k for k in self._local if k.startswith(prefix)]:
            self._remove_local(key)

    async def close(self) -> None:
        if self._redis is not None:
            try:
                await self._redis.aclose()
            except Exception:
                logger.debug("Redis close failed", exc_info=True)


_shared_cache: SharedCache | None = None


def get_shared_cache() -> SharedCache:
    global _shared_cache
    if _shared_cache is None:
        _shared_cache = SharedCache(settings.redis_url)
    return _shared_cache
