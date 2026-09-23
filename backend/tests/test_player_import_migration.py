"""Exercise real migrations in disposable databases, never application tables."""
import asyncio
import importlib.util
import os
from pathlib import Path
from uuid import uuid4
from types import SimpleNamespace

import pytest
import pytest_asyncio
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from fastapi import BackgroundTasks
from starlette.requests import Request

from app.database import engine as configured_engine
from app.models.game import Game
from app.models.position import Position
from app.models.import_job import ImportEvent, ImportJob
from app.routers import import_games
from app.services import import_jobs
from app.services.game_ingest import insert_game
from app.services.import_cache import should_fetch_archive
from app.services.import_jobs import append_import_event, create_import_job
from app.services.pgn_parser import parse_game_pgn
from app.services.tree_builder import update_tree_from_game
from test_game_ingest import build_game

pytestmark = pytest.mark.skipif(os.environ.get("CHESSGOD_TEST_POSTGRES") != "1", reason="Requires disposable PostgreSQL database")
MIGRATIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"


def migrate(connection, path, direction="upgrade"):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.op = Operations(MigrationContext.configure(connection))
    getattr(module, direction)()


@pytest_asyncio.fixture
async def database():
    name = "chessgod_import_test_" + uuid4().hex
    admin = create_async_engine(configured_engine.url, isolation_level="AUTOCOMMIT")
    engine = create_async_engine(configured_engine.url.set(database=name))
    created = False
    try:
        async with admin.connect() as connection:
            await connection.execute(text(f'CREATE DATABASE "{name}"'))
            created = True
        async with engine.begin() as connection:
            for path in sorted(MIGRATIONS.glob("*.py")):
                if path.name[:3].isdigit() and int(path.name[:3]) < 19:
                    await connection.run_sync(migrate, path)
        yield engine
    finally:
        await engine.dispose()
        if created:
            # Only the exact test database created by this fixture is removed.
            async with admin.connect() as connection:
                await connection.execute(text(f'DROP DATABASE "{name}"'))
        await admin.dispose()


@pytest.mark.asyncio
async def test_identity_migration_preserves_rows_and_roundtrips(database):
    path = MIGRATIONS / "019_player_import_integrity.py"
    async with database.begin() as connection:
        await connection.execute(text("""INSERT INTO games
            (chesscom_game_url, username, white_username, black_username, user_color,
             result, user_result, time_class, pgn, played_at)
            VALUES ('shared', 'Alice', 'Alice', 'Bob', 'white', '1-0', 'win', 'rapid', 'pgn', now())"""))
        await connection.execute(text("INSERT INTO import_archives (username, archive_url, archive_month, games_in_archive) VALUES ('Alice', 'https://archive/2020/01', '2020/01', 1)"))
        await connection.run_sync(migrate, path)
        assert await connection.scalar(text("SELECT count(*) FROM games WHERE username = 'ALICE'")) == 1
        assert await connection.scalar(text("SELECT username FROM games")) == "Alice"
        assert await connection.scalar(text("SELECT ownership_version FROM import_archives")) == 0
        await connection.run_sync(migrate, path, "downgrade")
        assert await connection.scalar(text("SELECT count(*) FROM games")) == 1
        await connection.run_sync(migrate, path)

    sessions = async_sessionmaker(database, expire_on_commit=False)
    async with sessions() as session:
        assert await should_fetch_archive(session, "ALICE", "https://archive/2020/01")
        # The second player's perspective can now be inserted.
        bob = build_game("shared", "shared", "black", "1-0", "rapid")
        bob.username = "Bob"
        assert await insert_game(session, bob) is not None
        await session.commit()
    with pytest.raises(RuntimeError, match="discarding"):
        async with database.begin() as connection:
            await connection.run_sync(migrate, path, "downgrade")
    async with sessions() as session:
        assert len(list(await session.scalars(select(Game)))) == 2


@pytest.mark.asyncio
async def test_real_postgres_concurrent_player_imports_and_job_lock(database):
    async with database.begin() as connection:
        await connection.run_sync(migrate, MIGRATIONS / "019_player_import_integrity.py")
    sessions = async_sessionmaker(database, expire_on_commit=False)
    parsed = parse_game_pgn('[Result "1-0"]\n\n1. e4 e5 1-0')
    ready = asyncio.Event()
    entered = 0

    async def import_player(name, color):
        nonlocal entered
        async with sessions() as session:
            await session.execute(text("SET statement_timeout = '10s'"))
            entered += 1
            if entered == 2:
                ready.set()
            await ready.wait()
            game = build_game("https://game/shared", "shared", color, "1-0", "rapid")
            game.username = name
            game_id = await insert_game(session, game)
            await update_tree_from_game(session, game_id, parsed, "1-0")
            await session.commit()

    await asyncio.wait_for(asyncio.gather(import_player("Alice", "white"), import_player("Bob", "black")), timeout=15)
    async with sessions() as session:
        assert len(list(await session.scalars(select(Game)))) == 2
        assert all(p.total_games == 1 for p in await session.scalars(select(Position)))

    async def claim(name):
        async with sessions() as session:
            result = await create_import_job(session, name)
            await session.commit()
            return result

    claims = await asyncio.wait_for(asyncio.gather(claim("Alice"), claim("ALICE")), timeout=15)
    assert sum(job is not None for job in claims) == 1
    async with sessions() as session:
        await append_import_event(session, next(job for job in claims if job), {"type": "complete"})
        await session.commit()
        assert await create_import_job(session, "aLiCe") is not None


@pytest.mark.asyncio
async def test_complete_import_workflow_for_both_players_and_cached_retry(database, monkeypatch):
    async with database.begin() as connection:
        await connection.run_sync(migrate, MIGRATIONS / "019_player_import_integrity.py")
    sessions = async_sessionmaker(database, expire_on_commit=False)
    monkeypatch.setattr(import_games, "async_session_factory", sessions)
    monkeypatch.setattr(import_jobs, "async_session_factory", sessions)
    downloads = []

    class Client:
        def __init__(self, http_client):
            pass

        async def fetch_archives(self, username):
            return [f"https://archive/{username}/2024/01"]

        async def fetch_monthly_games(self, url):
            downloads.append(url)
            return [{
                "url": "https://chess.com/game/shared", "time_class": "rapid", "end_time": 1704067200,
                "white": {"username": "Alice", "rating": 1500, "result": "win"},
                "black": {"username": "Bob", "rating": 1400, "result": "resigned"},
                "pgn": '[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 1-0',
            }]

    monkeypatch.setattr(import_games, "ChessComClient", Client)
    request = Request({"type": "http", "headers": [], "app": SimpleNamespace(state=SimpleNamespace(http_client=None))})
    for username, force in [("Alice", False), ("BOB", False), ("ALICE", False), ("bob", True)]:
        tasks = BackgroundTasks()
        async with sessions() as session:
            result = await import_games.start_import(username, tasks, request, force=force, session=session)
        await asyncio.wait_for(tasks(), timeout=10)
        async with sessions() as session:
            job = await session.get(ImportJob, result["job_id"])
            events = list(await session.scalars(select(ImportEvent).where(ImportEvent.job_id == job.id).order_by(ImportEvent.id)))
            assert job.status == "complete", [event.payload for event in events]
            assert events[-1].payload["type"] == "complete"
    assert len(downloads) == 3  # The historical Alice retry was served from cache.
    async with sessions() as session:
        games = list(await session.scalars(select(Game).order_by(Game.username)))
        assert len(games) == 2
        assert [(game.username, game.user_color, game.user_result) for game in games] == [
            ("alice", "white", "win"), ("bob", "black", "loss"),
        ]
        assert all(position.total_games == 1 for position in await session.scalars(select(Position)))
