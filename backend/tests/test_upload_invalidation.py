"""Uploads arrive about every forty seconds; they must not rebuild every
evidence cache each time, and the newest evidence must still land."""

from __future__ import annotations

import asyncio

import pytest

from app.services import improvement


@pytest.mark.asyncio
async def test_uploads_invalidate_at_once_then_coalesce_into_one_trailing_invalidation(monkeypatch):
    calls: list[str] = []

    async def record(username, *, include_queue_counts=True):
        assert include_queue_counts is False
        calls.append(username)

    monkeypatch.setattr(improvement, "invalidate_improvement_caches", record)
    monkeypatch.setattr(improvement, "_UPLOAD_INVALIDATION_INTERVAL_SECONDS", 0.05)
    improvement._last_upload_invalidation.clear()
    improvement._pending_upload_invalidation.clear()

    await improvement._invalidate_for_upload("Saint")
    assert calls == ["Saint"]  # the first upload is visible immediately

    for _ in range(5):  # a burst inside the interval
        await improvement._invalidate_for_upload("saint")
    assert calls == ["Saint"]

    await asyncio.sleep(0.1)
    assert calls == ["Saint", "saint"]  # exactly one trailing invalidation

    await asyncio.sleep(0.06)
    await improvement._invalidate_for_upload("saint")
    assert calls == ["Saint", "saint", "saint"]  # a quiet interval invalidates at once again
