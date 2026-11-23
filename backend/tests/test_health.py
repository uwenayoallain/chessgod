import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.database import get_db
from app.main import app
from app.models.base import Base
from app.services.observability import get_observability_store


ADMIN_PASSPHRASE = "born a saint"


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    """The real app against a throwaway database, without its startup.

    This used to be `with TestClient(app)`: that ran the app's lifespan and its
    background jobs (master-theory sync, cache warmup) and wrote the fake
    "frontend failure" event below into the real database on every test run —
    29 of them showed up in the observability panel as unexplained errors.
    """
    path = tmp_path_factory.mktemp("health") / "health.db"
    create_engine(f"sqlite:///{path}").connect().close()
    Base.metadata.create_all(create_engine(f"sqlite:///{path}"))
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}", poolclass=NullPool)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def test_db():
        async with sessions() as session:
            yield session

    app.dependency_overrides[get_db] = test_db
    try:
        # Not a context manager: that would run the lifespan and its workers.
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_health_endpoint_returns_ok(client: TestClient) -> None:
    get_observability_store()

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_observability_endpoint_reports_backend_request_metrics(client: TestClient) -> None:
    client.get("/api/health")
    response = client.get("/api/health/observability", headers={"X-Admin-Passphrase": ADMIN_PASSPHRASE})

    assert response.status_code == 200
    payload = response.json()
    assert payload["runtime"]["backend"]["total_requests"] >= 1
    assert isinstance(payload["runtime"]["backend"]["routes"], list)
    assert payload["request_id"]
    assert "total_events" in payload["persistent"]


def test_observability_endpoint_rejects_invalid_passphrase(client: TestClient) -> None:
    response = client.get("/api/health/observability", headers={"X-Admin-Passphrase": "wrong"})

    assert response.status_code == 401


def test_health_telemetry_ingest_adds_frontend_events(client: TestClient) -> None:
    ingest = client.post(
        "/api/health/telemetry",
        json={
            "events": [
                {
                    "kind": "error",
                    "name": "unhandledrejection",
                    "severity": "error",
                    "message": "frontend failure",
                }
            ]
        },
    )
    assert ingest.status_code == 202
    assert ingest.json()["accepted"] == 1

    response = client.get("/api/health/observability", headers={"X-Admin-Passphrase": ADMIN_PASSPHRASE})
    assert response.status_code == 200
    payload = response.json()
    assert payload["runtime"]["frontend"]["total_events"] >= 1
    assert "alerts" in payload["persistent"]
