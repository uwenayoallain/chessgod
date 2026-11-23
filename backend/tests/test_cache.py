import pytest

from app.services.cache import SharedCache


@pytest.mark.asyncio
async def test_old_calculation_cannot_repopulate_current_generation():
    cache = SharedCache(None)
    key = "improvement:candidates:v9:Alice:both:rapid_blitz"
    old_key = await cache.versioned_key(key)
    other_key = await cache.versioned_key("improvement:candidates:v9:bob:both:rapid_blitz")
    await cache.delete_prefix("improvement:candidates:v9:ALICE:")
    # Simulate the database query that started before invalidation finishing late.
    await cache.set_json(old_key, ["stale answer"], ttl_seconds=120)
    new_key = await cache.versioned_key(key)
    assert new_key != old_key
    assert await cache.get_json(new_key) is None
    assert await cache.versioned_key(key.lower()) == new_key
    assert await cache.versioned_key("improvement:candidates:v9:bob:both:rapid_blitz") == other_key


@pytest.mark.asyncio
@pytest.mark.parametrize("versioned_only", [False, True])
async def test_generation_changes_are_visible_across_redis_cache_instances(versioned_only):
    class Redis:
        def __init__(self):
            self.generations = {}
            self.values = {}
            self.scans = 0

        async def hmget(self, name, keys):
            return [self.generations.get(key) for key in keys]

        async def hset(self, name, key, value):
            self.generations[key] = value

        async def scan_iter(self, **kwargs):
            self.scans += 1
            for key in list(self.values):
                if key.startswith(kwargs["match"][:-1]):
                    yield key

        async def delete(self, *keys):
            for key in keys:
                self.values.pop(key, None)

        async def set(self, key, value, **kwargs):
            self.values[key] = value

        async def get(self, key):
            return self.values.get(key)

    redis = Redis()
    reader, writer = SharedCache(None), SharedCache(None)
    reader._redis = writer._redis = redis
    key = "improvement:coverage:v7:alice:both"
    old = await reader.versioned_key(key)
    await writer.delete_prefix("improvement:coverage:v7:alice:", versioned_only=versioned_only)
    assert redis.scans == (0 if versioned_only else 1)
    await reader.set_json(old, {"old": True}, ttl_seconds=120)
    current = await reader.versioned_key(key)
    assert current == await writer.versioned_key(key)
    assert current != old
    assert await reader.get_json(current) is None


@pytest.mark.asyncio
async def test_fallback_cache_is_bounded_and_evicts_least_recently_used() -> None:
    cache = SharedCache(None, max_entries=2, max_bytes=100)
    await cache.set_json("a", 1, ttl_seconds=60)
    await cache.set_json("b", 2, ttl_seconds=60)
    assert await cache.get_json("a") == 1
    await cache.set_json("c", 3, ttl_seconds=60)
    assert await cache.get_json("b") is None
    assert await cache.get_json("a") == 1
    assert await cache.get_json("c") == 3
    await cache.set_json("huge", "x" * 101, ttl_seconds=60)
    assert await cache.get_json("huge") is None
    assert cache._local_bytes <= 100


@pytest.mark.asyncio
async def test_expired_entries_are_reclaimed_even_if_never_read(monkeypatch) -> None:
    now = 100.0
    monkeypatch.setattr("app.services.cache.time.monotonic", lambda: now)
    cache = SharedCache(None)
    await cache.set_json("old", {"value": 1}, ttl_seconds=1)
    now = 102
    await cache.set_json("new", 2, ttl_seconds=60)
    assert "old" not in cache._local
    await cache.delete_prefix("new")
    assert cache._local_bytes == 0


@pytest.mark.asyncio
async def test_failed_invalidation_is_replayed_before_redis_keys_are_reused():
    class Redis:
        available = True

        def __init__(self):
            self.generations = {}

        async def hmget(self, name, keys):
            if not self.available:
                raise ConnectionError("Offline")
            return [self.generations.get(key) for key in keys]

        async def hset(self, name, key, value):
            if not self.available:
                raise ConnectionError("Offline")
            self.generations[key] = value

    redis = Redis()
    cache, other_worker = SharedCache(None), SharedCache(None)
    cache._redis = other_worker._redis = redis
    key = "improvement:coverage:alice:rapid_blitz"
    old_key = await cache.versioned_key(key)
    redis.available = False
    await cache.delete_prefix("improvement:coverage:alice:")
    assert await cache.versioned_key(key) != old_key
    assert cache._pending_invalidations
    redis.available = True
    new_key = await cache.versioned_key(key)
    assert new_key != old_key
    assert not cache._pending_invalidations
    assert await other_worker.versioned_key(key) == new_key
