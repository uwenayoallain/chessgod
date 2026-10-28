from __future__ import annotations

import pytest

from app import main


class _FakeSession:
    def __init__(self) -> None:
        self.committed = False
        self.rolled_back = False

    async def commit(self) -> None:
        self.committed = True

    async def rollback(self) -> None:
        self.rolled_back = True


class _FakeSessionFactory:
    def __init__(self) -> None:
        self.session = _FakeSession()

    async def __aenter__(self) -> _FakeSession:
        return self.session

    async def __aexit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        return None


class _FakeStore:
    def __init__(self, persisted: int) -> None:
        self.persisted = persisted
        self.calls = 0

    async def persist_queued_events(self, session: _FakeSession, max_items: int = 500) -> int:  # noqa: ARG002
        self.calls += 1
        return self.persisted


@pytest.mark.asyncio
async def test_flush_observability_events_commits_when_events_are_persisted(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _FakeStore(persisted=3)
    session_factory = _FakeSessionFactory()
    monkeypatch.setattr(main, "get_observability_store", lambda: store)
    monkeypatch.setattr(main, "async_session_factory", lambda: session_factory)

    count = await main.flush_observability_events(max_items=100)

    assert count == 3
    assert store.calls == 1
    assert session_factory.session.committed
    assert not session_factory.session.rolled_back


@pytest.mark.asyncio
async def test_flush_observability_events_rolls_back_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    class FailingStore(_FakeStore):
        async def persist_queued_events(self, session: _FakeSession, max_items: int = 500) -> int:  # noqa: ARG002
            raise RuntimeError("boom")

    store = FailingStore(persisted=0)
    session_factory = _FakeSessionFactory()
    monkeypatch.setattr(main, "get_observability_store", lambda: store)
    monkeypatch.setattr(main, "async_session_factory", lambda: session_factory)

    count = await main.flush_observability_events(max_items=100)

    assert count == 0
    assert session_factory.session.rolled_back
