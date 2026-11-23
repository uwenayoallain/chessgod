from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import main
from app.models.observability_event import ObservabilityEvent
from app.services import observability


@pytest.mark.asyncio
async def test_request_metrics_use_route_templates_and_track_active_players(monkeypatch) -> None:
    store = observability.ObservabilityStore()
    now = datetime(2026, 11, 1, tzinfo=UTC)
    monkeypatch.setattr(main, "get_observability_store", lambda: store)
    monkeypatch.setattr(observability, "_now_utc", lambda: now)
    app = FastAPI()
    app.middleware("http")(main.track_request_metrics)

    @app.get("/api/games/{game_id}")
    async def game(game_id: int):
        return {"id": game_id}

    @app.get("/api/training/repertoire")
    async def repertoire():
        return {}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await client.get("/api/games/1?username=Tester")
        await client.get("/api/games/2?username=Other")
        await client.get("/api/training/repertoire?username=Crawler&fresh=true")
        await client.get("/missing/1")
        await client.get("/missing/2")

    routes = {row["path"]: row["count"] for row in store.runtime_snapshot()["backend"]["routes"]}
    assert routes == {"/api/games/{game_id}": 2, "/api/training/repertoire": 1, "<unmatched>": 2}
    assert store.recently_active_usernames(60) == ["other", "tester"]
    now += timedelta(seconds=61)
    assert store.recently_active_usernames(60) == []


@pytest.mark.asyncio
async def test_observability_persistence_requeues_events_when_commit_fails(monkeypatch) -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(ObservabilityEvent.__table__.create)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    store = observability.ObservabilityStore()
    store.record_backend_request(
        method="GET", path="/api/games/1", status_code=200, duration_ms=1, request_id="first",
    )
    failed = False

    @asynccontextmanager
    async def session_factory():
        async with factory() as session:
            @event.listens_for(session.sync_session, "before_commit")
            def fail_one_commit(_session):
                nonlocal failed
                if not failed:
                    failed = True
                    raise RuntimeError("commit failed")
            yield session

    monkeypatch.setattr(main, "get_observability_store", lambda: store)
    monkeypatch.setattr(main, "async_session_factory", session_factory)
    assert await main.flush_observability_events() == 0
    assert await main.flush_observability_events() == 1
    assert await main.flush_observability_events() == 0
    async with factory() as session:
        assert (await session.scalars(select(ObservabilityEvent.request_id))).all() == ["first"]
    await engine.dispose()
