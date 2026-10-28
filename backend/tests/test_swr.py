"""Stale-while-revalidate: a stale read is served at once and rebuilt behind it."""

from __future__ import annotations

import asyncio

import pytest

from app.services import swr
from app.services.cache import get_shared_cache


class _Session:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.mark.asyncio
async def test_a_stale_read_serves_the_last_answer_and_rebuilds_once(monkeypatch):
    monkeypatch.setattr(swr, "async_session_factory", _Session)
    cache = get_shared_cache()
    calls: list[int] = []

    async def compute(_session):
        calls.append(1)
        await asyncio.sleep(0.01)
        return {"n": len(calls)}

    async def read():
        return await swr.stale_while_revalidate(
            _Session(), fresh_base="swrtest:u:k", last_key="swrtest-last:u:k",
            compute=compute, fresh_ttl=60,
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
