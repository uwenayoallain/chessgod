"""Re-syncing an archive: stored games are recognised before any PGN is parsed."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
import pytest_asyncio
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.import_job import ImportEvent
from app.routers import import_games
from app.services import import_cache, import_jobs
from app.services.import_jobs import create_import_job
from app.services.pgn_parser import parse_game_pgn
from app.services.tree_builder import backfill_position_clocks_by_game_id

# The current month: re-fetched on every sync, after reading its cache record.
ARCHIVE = f"https://api.chess.com/pub/player/tester/games/{datetime.now(UTC):%Y/%m}"

SCHOLARS = ("1. e4 {[%clk 0:09:58]} e5 {[%clk 0:09:57]} 2. Qh5 {[%clk 0:09:50]} Nc6 {[%clk 0:09:40]} "
            "3. Bc4 {[%clk 0:09:30]} Nf6 {[%clk 0:09:20]} 4. Qxf7# {[%clk 0:09:10]} 1-0")


def pgn(moves: str = SCHOLARS) -> str:
    return f'[White "Tester"]\n[Black "opponent"]\n[Result "1-0"]\n[TimeControl "600"]\n\n{moves}\n'


def raw(game_id: int, moves: str = SCHOLARS) -> dict:
    return {
        "url": f"https://www.chess.com/game/live/{game_id}", "pgn": pgn(moves), "rules": "chess",
        "time_class": "rapid", "time_control": "600", "end_time": 1_704_100_000 + game_id,
        "white": {"username": "Tester", "rating": 1500, "result": "win"},
        "black": {"username": "opponent", "rating": 1500, "result": "checkmated"},
    }


@pytest_asyncio.fixture
async def sessions(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    opened = []

    def tracking_factory():
        session = factory()
        opened.append(session)
        return session

    tracking_factory.opened = opened
    monkeypatch.setattr(import_games, "async_session_factory", tracking_factory)
    monkeypatch.setattr(import_jobs, "async_session_factory", factory)
    yield tracking_factory
    await engine.dispose()


class FakeClient:
    archive: list[dict] = []
    in_transaction_during_fetch: list[bool] = []
    worker = None

    def __init__(self, http_client) -> None:
        del http_client

    async def fetch_archives(self, username: str) -> list[str]:
        return [ARCHIVE]

    async def fetch_monthly_games(self, archive_url: str) -> list[dict]:
        FakeClient.in_transaction_during_fetch.append(FakeClient.worker().in_transaction())
        return list(FakeClient.archive)


async def run(sessions, monkeypatch, games: list[dict]) -> tuple[int | None, list[dict]]:
    async with sessions() as session:
        job_id = await create_import_job(session, "tester")
        await session.commit()
    FakeClient.archive = games
    monkeypatch.setattr(import_games, "ChessComClient", FakeClient)
    before = len(sessions.opened)
    FakeClient.worker = lambda: sessions.opened[before]
    new_games = await import_games.run_import("tester", object(), job_id=job_id)
    async with sessions() as session:
        events = [event.payload for event in await session.scalars(
            select(ImportEvent).where(ImportEvent.job_id == job_id).order_by(ImportEvent.id))]
    return new_games, events


@pytest.mark.asyncio
async def test_a_resync_parses_only_the_games_that_still_need_something(sessions, monkeypatch) -> None:
    assert (await run(sessions, monkeypatch, [raw(1), raw(2)]))[0] == 2

    async with sessions() as session:
        first, second = (await session.scalars(select(Game.id).order_by(Game.id))).all()
        # Game 1 predates termination capture; game 2 lost two of its clocks.
        await session.execute(update(Game).where(Game.id == first).values(termination=None))
        await session.execute(update(GamePosition).where(
            GamePosition.game_id == second, GamePosition.ply.in_([2, 3]),
        ).values(clock_seconds_after=None, think_seconds=None))
        await session.commit()

    parsed: list[str] = []

    def counting_parse(text: str):
        parsed.append(text)
        return parse_game_pgn(text)

    monkeypatch.setattr(import_games, "parse_game_pgn", counting_parse)
    FakeClient.in_transaction_during_fetch.clear()
    new_games, events = await run(sessions, monkeypatch, [raw(1), raw(2), raw(3)])

    assert new_games == 1
    # Game 1 needed only its termination, read from the archive's JSON: no parse.
    assert len(parsed) == 2
    [complete] = [event for event in events if event["type"] == "archive_complete"]
    assert (complete["new_games"], complete["skipped_games"], complete["games_in_archive"]) == (1, 2, 3)
    # The cache read was committed before the network wait.
    assert FakeClient.in_transaction_during_fetch == [False]
    async with sessions() as session:
        assert await session.scalar(select(Game.termination).where(Game.id == first)) == "checkmated"
        clocks = dict((await session.execute(
            select(GamePosition.ply, GamePosition.clock_seconds_after).where(GamePosition.game_id == second)
        )).all())
        assert clocks[2] == 597.0 and clocks[3] == 590.0
        assert await session.scalar(select(Game.id).where(Game.chesscom_game_url.like("%/3"))) is not None


@pytest.mark.asyncio
async def test_a_stored_game_with_its_clocks_is_never_parsed_again(sessions, monkeypatch) -> None:
    await run(sessions, monkeypatch, [raw(1)])

    def refuse(text: str):
        raise AssertionError("a complete stored game was parsed")

    monkeypatch.setattr(import_games, "parse_game_pgn", refuse)
    new_games, events = await run(sessions, monkeypatch, [raw(1)])
    assert new_games == 0
    assert events[-1] == {"type": "complete", "total_new_games": 0, "total_skipped": 1, "cached_archives": 0}


@pytest.mark.asyncio
async def test_a_clock_backfill_reports_only_the_rows_it_filled(sessions, monkeypatch) -> None:
    await run(sessions, monkeypatch, [raw(1)])
    async with sessions() as session:
        game_id = await session.scalar(select(Game.id))
        await session.execute(update(GamePosition).where(
            GamePosition.game_id == game_id, GamePosition.ply.in_([1, 2]),
        ).values(clock_seconds_after=None))
        # This PGN has clocks for plies 2 and 3 only: one of the two missing plies
        # and one that already has its clock. Only ply 2 can be filled.
        partial = parse_game_pgn(pgn(
            "1. e4 e5 {[%clk 0:09:57]} 2. Qh5 {[%clk 0:09:50]} Nc6 3. Bc4 Nf6 4. Qxf7# 1-0"))
        assert await backfill_position_clocks_by_game_id(session, game_id, partial) == 1
        assert await backfill_position_clocks_by_game_id(session, game_id, partial) == 0
        clocks = dict((await session.execute(
            select(GamePosition.ply, GamePosition.clock_seconds_after).where(GamePosition.game_id == game_id)
        )).all())
        assert (clocks[1], clocks[2], clocks[3]) == (None, 597.0, 590.0)
        # No clocks at all in the PGN: nothing to do.
        bare = parse_game_pgn(pgn("1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0"))
        assert await backfill_position_clocks_by_game_id(session, game_id, bare) == 0


def test_termination_is_why_the_game_ended() -> None:
    game = raw(1)
    assert import_games.termination_for(game, "white") == "checkmated"
    assert import_games.termination_for(game, "black") == "checkmated"
    assert import_games.termination_for({"white": {"result": "agreed"}, "black": {"result": "agreed"}},
                                        "white") == "agreed"


@pytest.mark.asyncio
async def test_old_cached_archive_uses_one_lookup_and_its_stored_count(sessions, monkeypatch) -> None:
    old_archive = "https://api.chess.com/pub/player/tester/games/2020/01"

    async def archives(self, username):
        return [old_archive]

    monkeypatch.setattr(FakeClient, "fetch_archives", archives)
    assert (await run(sessions, monkeypatch, [raw(1)]))[0] == 1
    calls = []
    get_cached = import_cache.get_cached_archive

    async def counting_get(session, username, url):
        calls.append(url)
        return await get_cached(session, username, url)

    monkeypatch.setattr(import_cache, "get_cached_archive", counting_get)
    FakeClient.in_transaction_during_fetch.clear()
    new, events = await run(sessions, monkeypatch, [])
    assert new == 0
    assert calls == [old_archive]
    assert FakeClient.in_transaction_during_fetch == []
    [archive] = [event for event in events if event["type"] == "archive_complete"]
    assert archive["cached"] and archive["skipped_games"] == archive["games_in_archive"] == 1


@pytest.mark.asyncio
async def test_missing_clocks_without_annotations_need_no_parse(sessions, monkeypatch) -> None:
    bare = raw(1, "1. e4 e5 2. Nf3 1-0")
    assert (await run(sessions, monkeypatch, [bare]))[0] == 1

    def refuse(text):
        raise AssertionError("No clocks in the source PGN")

    monkeypatch.setattr(import_games, "parse_game_pgn", refuse)
    new, events = await run(sessions, monkeypatch, [bare])
    assert new == 0 and events[-1]["total_skipped"] == 1
