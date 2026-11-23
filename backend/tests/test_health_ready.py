"""Liveness answers for the process; readiness answers for the database."""

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.database import get_db
from app.models.base import Base
from app.routers import health as health_router


def _client(session_dependency) -> TestClient:
    # The router alone: the real app would bring its startup and its database.
    app = FastAPI()
    app.include_router(health_router.router, prefix="/api")
    app.dependency_overrides[get_db] = session_dependency
    return TestClient(app)


class _Session:
    """A session whose database never answers, or answers with an error."""

    def __init__(self, behaviour) -> None:
        self.behaviour = behaviour
        self.statements = 0

    async def execute(self, statement):
        self.statements += 1
        return await self.behaviour()


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "ready.db"
    Base.metadata.create_all(create_engine(f"sqlite:///{path}"))
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}", poolclass=NullPool)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def dependency():
        async with sessions() as session:
            yield session

    return dependency


def test_readiness_is_ok_when_the_database_answers(database) -> None:
    response = _client(database).get("/api/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


def test_readiness_is_503_when_the_database_is_unreachable() -> None:
    async def refused():
        raise OperationalError("SELECT 1", {}, ConnectionRefusedError("connection refused"))

    session = _Session(refused)

    async def dependency():
        yield session

    response = _client(dependency).get("/api/health/ready")
    assert response.status_code == 503
    assert response.json() == {"detail": "Database unavailable"}
    assert session.statements == 1


def test_readiness_is_503_when_the_database_does_not_answer_in_time(monkeypatch) -> None:
    # A lost database rarely refuses: it stops answering. The probe must give
    # up by itself, well inside the healthcheck's own timeout.
    monkeypatch.setattr(health_router, "READY_TIMEOUT_SECONDS", 0.05)
    released = asyncio.Event()

    async def hangs():
        try:
            await asyncio.sleep(30)
        finally:
            released.set()

    async def dependency():
        yield _Session(hangs)

    response = _client(dependency).get("/api/health/ready")
    assert response.status_code == 503
    assert response.json() == {"detail": "Database unavailable"}
    # The wait was abandoned, not left running behind the answer.
    assert released.is_set()


def test_liveness_answers_without_the_database() -> None:
    # No session is opened at all: a process with no database is still alive,
    # and saying so must not wait on one.
    opened = 0

    async def dependency():
        nonlocal opened
        opened += 1
        async def refused():
            raise OperationalError("SELECT 1", {}, ConnectionRefusedError("connection refused"))
        yield _Session(refused)

    response = _client(dependency).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert opened == 0


def test_the_probe_stays_under_the_healthcheck_timeout() -> None:
    # docker-compose.yml gives the healthcheck's client three seconds.
    assert health_router.READY_TIMEOUT_SECONDS < 3
