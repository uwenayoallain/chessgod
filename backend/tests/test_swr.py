"""Stale-while-revalidate: a stale read is served at once and rebuilt behind it."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from redis.exceptions import WatchError

from app.services import swr
from app.services.cache import get_shared_cache


class _Session:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.mark.asyncio
async def test_a_stale_read_serves_the_last_answer_and_rebuilds_once():
    cache = get_shared_cache()
    calls: list[int] = []

    async def compute(_session):
        calls.append(1)
        await asyncio.sleep(0.01)
        return {"n": len(calls)}

    async def read():
        return await swr.stale_while_revalidate(
            _Session(), fresh_base="swrtest:u:k", last_key="swrtest-last:u:k",
            compute=compute, fresh_ttl=60, session_factory=_Session,
        )

    assert await read() == {"n": 1}  # nothing cached: the reader waits once
    assert await read() == {"n": 1}  # fresh hit
    assert len(calls) == 1

    await cache.delete_prefix("swrtest:u:", versioned_only=True)  # new evidence
    assert await read() == {"n": 1}  # stale, served at once...
    assert await read() == {"n": 1}  # ...and only one rebuild is started
    await asyncio.sleep(0.05)
    assert len(calls) == 2
    assert await read() == {"n": 2}  # the rebuilt answer is fresh

    # Without either copy the reader waits for a build again.
    await cache.delete_prefix("swrtest:u:")
    await cache.delete_prefix("swrtest-last:u:")
    assert await read() == {"n": 3}


@pytest.mark.asyncio
async def test_concurrent_cold_misses_share_one_build() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def compute(_session):
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return {"calls": calls}

    async def read():
        return await swr.stale_while_revalidate(
            _Session(), fresh_base="cold:u:k", last_key="cold-last:u:k",
            compute=compute, fresh_ttl=60, session_factory=_Session,
        )

    readers = [asyncio.create_task(read()) for _ in range(8)]
    await asyncio.wait_for(entered.wait(), timeout=1)
    release.set()
    assert await asyncio.gather(*readers) == [{"calls": 1}] * 8
    assert calls == 1


@pytest.mark.asyncio
async def test_cancelling_the_first_cold_reader_leaves_the_shared_build_running() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()
    second_reading = asyncio.Event()
    own_session = _Session()
    calls = 0

    async def compute(db):
        nonlocal calls
        assert db is own_session
        calls += 1
        entered.set()
        await release.wait()
        return {"calls": calls}

    async def read(started=None):
        if started is not None:
            started.set()
        return await swr.stale_while_revalidate(
            _Session(), fresh_base="cancel:u:k", last_key="cancel-last:u:k",
            compute=compute, fresh_ttl=60, session_factory=lambda: own_session,
        )

    first = asyncio.create_task(read())
    await asyncio.wait_for(entered.wait(), timeout=1)
    second = asyncio.create_task(read(second_reading))
    await asyncio.wait_for(second_reading.wait(), timeout=1)
    first.cancel()
    try:
        with pytest.raises(asyncio.CancelledError):
            await first
    finally:
        release.set()
    assert await asyncio.wait_for(second, timeout=1) == {"calls": 1}
    assert calls == 1


@pytest.mark.asyncio
async def test_forced_refresh_bypasses_a_running_stale_build() -> None:
    cache = get_shared_cache()
    entered = asyncio.Event()
    release = asyncio.Event()
    request_session = _Session()
    await cache.set_json("forced-last:u:k", {"value": "last"}, ttl_seconds=60)

    async def compute(db):
        if db is request_session:
            return {"value": "new"}
        entered.set()
        await release.wait()
        return {"value": "old"}

    async def read(*, force_refresh=False):
        return await swr.stale_while_revalidate(
            request_session, fresh_base="forced:u:k", last_key="forced-last:u:k",
            compute=compute, fresh_ttl=60, session_factory=_Session, force_refresh=force_refresh,
        )

    assert await read() == {"value": "last"}
    [stale_build] = swr._refreshes.values()
    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert await asyncio.wait_for(read(force_refresh=True), timeout=1) == {"value": "new"}
        assert not stale_build.done()
    finally:
        release.set()
        await stale_build
    assert await read() == {"value": "new"}


@pytest.mark.asyncio
@pytest.mark.parametrize("prior_value", [False, True])
async def test_paused_build_cannot_resurrect_invalidated_keys(prior_value) -> None:
    cache = get_shared_cache()
    fresh_base = "fence:u:k"
    last_key = "fence-last:u:k"
    entered = asyncio.Event()
    release = asyncio.Event()

    async def compute(_session):
        entered.set()
        await release.wait()
        return {"old": True}

    async def read():
        return await swr.stale_while_revalidate(
            _Session(), fresh_base=fresh_base, last_key=last_key, compute=compute, fresh_ttl=60,
            session_factory=_Session,
        )

    if prior_value:
        await cache.set_json(last_key, {"last": True}, ttl_seconds=60)
    reader = asyncio.create_task(read())
    await asyncio.wait_for(entered.wait(), timeout=1)
    old_fresh_key = await cache.versioned_key(fresh_base)
    await cache.delete_prefix("fence:u:")
    await cache.delete_prefix("fence-last:u:")
    new_fresh_key = await cache.versioned_key(fresh_base)
    await cache.set_json(new_fresh_key, {"new": True}, ttl_seconds=60)
    flights = list(swr._refreshes.values())
    release.set()
    await reader
    await asyncio.gather(*flights)

    assert await cache.get_json(old_fresh_key) is None
    assert await cache.get_json(last_key) is None
    assert await read() == {"new": True}


@pytest.mark.asyncio
async def test_redis_watch_rechecks_generation_after_conflicting_invalidation(monkeypatch) -> None:
    cache = get_shared_cache()
    generations = {}
    fresh_base = "redis-fence:u:k"
    last_key = "redis-fence-last:u:k"

    async def hmget(_hash, prefixes):
        return [generations.get(prefix) for prefix in prefixes]

    async def invalidate_during_publish():
        generations["redis-fence:u:"] = "next-generation"
        raise WatchError()

    first = Mock()
    first.watch = AsyncMock()
    first.hmget = hmget
    first.execute = AsyncMock(side_effect=invalidate_during_publish)
    second = Mock()
    second.watch = AsyncMock()
    second.hmget = hmget
    second.execute = AsyncMock()
    pipelines = iter((first, second))

    class Pipeline:
        async def __aenter__(self):
            return next(pipelines)

        async def __aexit__(self, *_exc):
            return False

    monkeypatch.setattr(cache, "_redis", SimpleNamespace(hmget=hmget, pipeline=Pipeline))
    fresh_key = await cache.versioned_key(fresh_base)
    await swr._publish(
        cache, fresh_base, fresh_key,
        last_key, await cache.versioned_key(last_key), {"old": True}, 60, 60,
    )
    assert [call.args[0] for call in first.set.call_args_list] == [fresh_key, last_key]
    first.execute.assert_awaited_once()
    second.set.assert_not_called()
    second.execute.assert_not_awaited()
