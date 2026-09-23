import asyncio
import json
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.requests import Request

from app.models.base import Base
from app.models.game import Game
from app.models.import_job import ImportJob
from app.models.position import Position
from app.models.position_move import PositionMove
from app.routers import import_games
from app.services.import_jobs import (
    ImportJobInactive, append_import_event, create_import_job, guard_import_commit,
)
from app.services.game_ingest import insert_game
from app.services.pgn_parser import parse_game_pgn
from app.services.tree_builder import update_tree_from_game
from test_game_ingest import build_game


@pytest_asyncio.fixture
async def sessions(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(import_games, "async_session_factory", factory)
    yield factory
    await engine.dispose()


def request(last_id=""):
    return Request({"type": "http", "headers": [(b"last-event-id", last_id.encode())]})


@pytest.mark.asyncio
async def test_import_events_broadcast_replay_and_resume(sessions):
    async with sessions() as session:
        job_id = await create_import_job(session, "Tester")
        await append_import_event(session, job_id, {"type": "archive_start", "archive": "2024/01"})
        await append_import_event(session, job_id, {"type": "complete", "total_new_games": 2})
        await session.commit()

    async def read(last_id=""):
        response = await import_games.import_status("TESTER", request(last_id))
        return [event async for event in response.body_iterator]

    first, second = await asyncio.wait_for(asyncio.gather(read(), read()), timeout=2)
    assert first == second
    assert [json.loads(e["data"])["type"] for e in first] == ["archive_start", "complete"]
    assert await read(first[0]["id"]) == first[1:]
    assert await read(first[-1]["id"]) == []
    assert await read("previous-job:999999") == first


@pytest.mark.asyncio
async def test_job_lock_ignores_case_and_expired_job_can_be_retried(sessions):
    async with sessions() as session:
        original = await create_import_job(session, "Tester")
        await session.commit()
        assert await create_import_job(session, "TESTER") is None
        await session.execute(update(ImportJob).where(ImportJob.id == original).values(
            updated_at=datetime.now(UTC) - timedelta(minutes=11)))
        replacement = await create_import_job(session, "tester")
        assert replacement is not None and replacement != original
        with pytest.raises(ImportJobInactive):
            await guard_import_commit(session, original)
        await guard_import_commit(session, replacement)
        assert not await append_import_event(session, original, {"type": "complete"})
        await session.commit()


@pytest.mark.asyncio
async def test_start_import_uses_persisted_job_and_case_insensitive_conflict(sessions):
    async with sessions() as session:
        tasks = BackgroundTasks()
        started = await import_games.start_import("Tester", tasks, request(), session=session)
        assert await session.get(ImportJob, started["job_id"]) is not None
        assert tasks.tasks[0].kwargs["job_id"] == started["job_id"]
        with pytest.raises(HTTPException) as error:
            await import_games.start_import("TESTER", BackgroundTasks(), request(), session=session)
        assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_status_reports_expired_job_instead_of_waiting_forever(sessions):
    async with sessions() as session:
        job_id = await create_import_job(session, "tester")
        await session.execute(update(ImportJob).where(ImportJob.id == job_id).values(
            updated_at=datetime.now(UTC) - timedelta(minutes=11)))
        await session.commit()
    response = await import_games.import_status("TESTER", request())
    events = [event async for event in response.body_iterator]
    assert len(events) == 1
    assert json.loads(events[0]["data"])["type"] == "error"


@pytest.mark.asyncio
async def test_both_participants_own_the_game_without_double_counting_tree(sessions):
    parsed = parse_game_pgn('[Result "1-0"]\n\n1. e4 e5 2. Nf3 1-0')
    async with sessions() as session:
        white = build_game("https://chess.com/game/shared", "shared", "white", "1-0", "rapid")
        white.username = "Alice"
        first = await insert_game(session, white)
        await update_tree_from_game(session, first, parsed, "1-0")
        await session.commit()
        black = build_game(white.chesscom_game_url, "shared", "black", "1-0", "rapid", termination="resigned")
        black.username = "Bob"
        second = await insert_game(session, black)
        assert second is not None and first != second
        await update_tree_from_game(session, second, parsed, "1-0")
        await session.commit()
        assert await session.scalar(select(func.count()).select_from(Game)) == 2
        assert (await session.scalar(select(Game).where(Game.username == "ALICE"))).user_result == "win"
        assert (await session.scalar(select(Game).where(Game.username == "BOB"))).user_result == "loss"
        assert all(row.total_games == 1 for row in await session.scalars(select(Position)))
        assert all(row.game_count == 1 for row in await session.scalars(select(PositionMove)))
        white.username = "ALICE"
        white.termination = "timeout"
        assert await insert_game(session, white) is None
        await session.commit()
        assert (await session.scalar(select(Game).where(Game.username == "bob"))).termination == "resigned"
        summary = await import_games.build_import_summary(session, "ALICE")
        assert summary.total_games == 1


@pytest.mark.asyncio
async def test_summary_reports_the_rating_of_each_time_controls_latest_game(sessions):
    start = datetime(2026, 1, 1, tzinfo=UTC)
    games = [
        # (time_class, user_color, white_rating, black_rating, days)
        ("rapid", "white", 1400, 1500, 0),
        ("rapid", "black", 1500, 1651, 30),
        ("blitz", "white", 1358, 1300, 10),
        ("blitz", "black", 1300, 1200, 5),
    ]
    async with sessions() as session:
        for index, (time_class, color, white, black, days) in enumerate(games):
            game = build_game(f"https://chess.com/game/r{index}", f"r{index}", color, "1-0", time_class)
            game.white_rating = white
            game.black_rating = black
            game.played_at = start + timedelta(days=days)
            session.add(game)
        await session.commit()
        summary = await import_games.build_import_summary(session, "tester")
    # The player's own side of their newest game, not an average over history.
    assert summary.current_ratings == {"rapid": 1651, "blitz": 1358}
