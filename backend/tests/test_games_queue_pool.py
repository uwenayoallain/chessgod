"""The analysis queue's pool: one walk per scope, off the request's path."""

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_outcome import PositionOutcome
from app.routers import games as games_router
from app.routers.games import (
    _DecisionPairTarget,
    _is_storable_fen,
    _member_of,
    _not_member_of,
    _pair_not_among,
    _QueueReader,
    _QueueScope,
    unanalyzed_fens,
)
from app.services.cache import get_shared_cache

_WALK = "SELECT min(games.played_at)"


@pytest.fixture(autouse=True)
def symbolic_queue_fens(monkeypatch):
    monkeypatch.setattr(games_router, "_is_storable_fen", lambda fen: True)


def _game(game_id: int) -> Game:
    return Game(
        id=game_id,
        chesscom_game_url=f"https://chess.com/game/{game_id}",
        chesscom_game_id=str(game_id),
        username="tester",
        white_username="tester",
        black_username="opponent",
        user_color="white",
        result="1-0",
        user_result="win",
        time_class="blitz",
        time_control="600",
        white_rating=1200,
        black_rating=1200,
        pgn="1. e4 e5 1-0",
        eco="C50",
        opening_name="Italian Game",
        played_at=datetime(2024, 1, game_id, tzinfo=UTC),
        num_moves=2,
    )


@pytest_asyncio.fixture
async def library(tmp_path):
    """Ten games of middlegame decisions in a database with real connections.

    A file and no pool, not `:memory:`: an in-memory SQLite database is one
    connection shared by every session, and these tests are about requests and
    walks that each hold their own.
    """

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'queue.db'}", poolclass=NullPool)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        position_id = 0
        for game_id in range(1, 11):
            session.add(_game(game_id))
            for ply in range(40, 44):
                position_id += 1
                session.add(Position(id=position_id, fen=f"g{game_id}-p{ply}", total_games=1))
                session.add(GamePosition(game_id=game_id, position_id=position_id, ply=ply,
                                         move_san="Nf6", move_uci="g8f6"))
        await session.commit()
    walks: list[str] = []

    @event.listens_for(engine.sync_engine, "before_cursor_execute")
    def count_walks(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith(_WALK):
            walks.append(statement)

    yield session_factory, walks
    await asyncio.gather(*list(games_router._pool_flights.values()), return_exceptions=True)
    await engine.dispose()


async def _ask(session_factory, **overrides) -> dict:
    async with session_factory() as session:
        return await unanalyzed_fens(**{
            "username": "tester", "color": "both", "time_class": "rapid_blitz",
            "min_depth": 20, "limit": 4, "session": session, **overrides,
        })


async def _search(session_factory, fens) -> None:
    """The crawler searches and uploads the batch it was given."""
    async with session_factory() as session:
        ids = {position.fen: position.id for position in (await session.execute(select(Position))).scalars()}
        session.add_all(
            AnalysisResult(position_id=ids[fen], engine="stockfish-19", engine_version="19", depth=20,
                           eval_cp=0, best_move_uci="e2e4", best_move_san="e4", multipv_rank=1)
            for fen in fens
        )
        await session.commit()


@pytest.mark.asyncio
async def test_requests_arriving_together_share_one_walk_of_the_library(library, monkeypatch) -> None:
    # With no pool yet, each request used to walk the whole library itself:
    # three engines starting together meant three walks side by side.
    session_factory, walks = library
    monkeypatch.setattr(games_router, "_MIN_RECENT_DECISIONS", 40)
    monkeypatch.setattr(games_router, "_RECENT_DECISION_OVERFETCH", 1)

    answers = await asyncio.gather(*(_ask(session_factory) for _ in range(3)))

    assert len(walks) == 1, "requests for the same scope walked the library side by side"
    assert all(answer["fens"] == answers[0]["fens"] and len(answer["fens"]) == 4 for answer in answers)
    assert games_router._pool_flights == {}

    # A different scope is a different pool, and walks for itself.
    await _ask(session_factory, min_depth=24)
    assert len(walks) == 2


@pytest.mark.asyncio
async def test_a_client_that_stops_waiting_leaves_the_walk_running(library, monkeypatch) -> None:
    # The crawler gave up on a slow answer, and its walk was thrown away with
    # the request; the next try began the walk again from nothing.
    session_factory, walks = library
    monkeypatch.setattr(games_router, "_MIN_RECENT_DECISIONS", 40)
    monkeypatch.setattr(games_router, "_RECENT_DECISION_OVERFETCH", 1)

    impatient = asyncio.create_task(_ask(session_factory))
    while not games_router._pool_flights:
        await asyncio.sleep(0)
    [walk] = games_router._pool_flights.values()
    impatient.cancel()
    with pytest.raises(asyncio.CancelledError):
        await impatient
    assert not walk.cancelled()

    await walk
    answer = await _ask(session_factory)
    assert len(answer["fens"]) == 4
    assert len(walks) == 1, "the walk a client abandoned was run again"


@pytest.mark.asyncio
async def test_a_pool_that_ran_short_is_served_while_one_walk_refills_it(library, monkeypatch) -> None:
    session_factory, walks = library
    # A pool of four pairs out of the twenty the library holds.
    monkeypatch.setattr(games_router, "_MIN_RECENT_DECISIONS", 4)
    monkeypatch.setattr(games_router, "_RECENT_DECISION_OVERFETCH", 1)
    monkeypatch.setattr(games_router, "_POOL_REFILL_FACTOR", 1)

    first = await _ask(session_factory)
    assert len(first["fens"]) == 4 and len(walks) == 1
    searched = first["fens"][:2]
    await _search(session_factory, searched)

    # Each request can use the remaining pairs while one walk refills the pool.
    answers = await asyncio.gather(*(_ask(session_factory) for _ in range(3)))
    assert all(len(answer["fens"]) == 4 for answer in answers)
    assert not any(set(answer["fens"]) & set(searched) for answer in answers)
    await asyncio.gather(*list(games_router._pool_flights.values()))
    assert len(walks) == 2, "a short pool was refilled more than once, or not at all"

    refilled = await _ask(session_factory)
    assert len(walks) == 2
    assert sum(refilled["selected_decision_pairs_by_phase"].values()) == 2


@pytest.mark.asyncio
async def test_an_exhausted_full_pool_is_refilled_before_selecting_pairs(library, monkeypatch) -> None:
    session_factory, walks = library
    monkeypatch.setattr(games_router, "_MIN_RECENT_DECISIONS", 2)
    monkeypatch.setattr(games_router, "_RECENT_DECISION_OVERFETCH", 1)
    monkeypatch.setattr(games_router, "_POOL_REFILL_FACTOR", 1)

    first = await _ask(session_factory, limit=2)
    assert len(walks) == 1
    cache = get_shared_cache()
    assert not any(":rebuilt:generation:" in key for key in cache._local)
    [pool_key] = [key for key in cache._local if key.startswith("queue-pool:")]
    pool = await cache.get_json(pool_key)
    searched = {pair[key] for pair in pool["pairs"] for key in ("parent_fen", "child_fen")}
    assert set(first["fens"]) <= searched
    await _search(session_factory, searched)

    refilled = await _ask(session_factory, limit=2)
    assert len(walks) == 2
    assert len(refilled["fens"]) == 2
    assert not set(refilled["fens"]) & searched
    assert sum(refilled["selected_decision_pairs_by_phase"].values()) == 1
    assert not games_router._pool_flights


@pytest.mark.asyncio
async def test_a_walk_that_cannot_fill_its_target_gets_a_rest(library, monkeypatch) -> None:
    session_factory, walks = library
    monkeypatch.setattr(games_router, "_MIN_RECENT_DECISIONS", 40)
    monkeypatch.setattr(games_router, "_POOL_REFILL_FACTOR", 40)

    first = await _ask(session_factory)
    cache = get_shared_cache()
    [rest_key] = [key for key in cache._local if ":rebuilt:generation:" in key]
    assert await cache.get_json(rest_key) is True
    assert (await _ask(session_factory))["fens"] == first["fens"]
    assert len(walks) == 1 and not games_router._pool_flights


@pytest.mark.asyncio
async def test_background_walks_can_open_a_session_only_for_an_engine_bind(library) -> None:
    session_factory, _ = library
    async with session_factory() as session:
        engine = session.bind
        assert games_router._async_engine_for(session) is engine
    legacy_bind = SimpleNamespace(bind=engine.sync_engine)
    assert games_router._async_engine_for(legacy_bind).sync_engine is engine.sync_engine
    async with engine.connect() as connection, AsyncSession(bind=connection) as session:
        assert games_router._async_engine_for(session) is None
        reply = await _ask(session_factory, session=session)
        assert len(reply["fens"]) == 4
        assert not games_router._pool_flights


@pytest.mark.asyncio
async def test_an_old_pool_is_served_and_replaced_behind_the_request(library, monkeypatch) -> None:
    # The pool used to expire after an hour, and the request that found it
    # gone walked the library before it could answer.
    session_factory, walks = library
    monkeypatch.setattr(games_router, "_MIN_RECENT_DECISIONS", 40)
    monkeypatch.setattr(games_router, "_RECENT_DECISION_OVERFETCH", 1)

    first = await _ask(session_factory)
    assert len(walks) == 1

    monkeypatch.setattr(games_router, "_POOL_TTL_SECONDS", 0.0)
    second = await _ask(session_factory)
    assert second["fens"] == first["fens"]
    [walk] = games_router._pool_flights.values()
    assert not walk.done(), "the request waited for the walk that replaces an old pool"
    await walk
    assert len(walks) == 2

    # The pool it left is new again: nothing more to replace.
    monkeypatch.setattr(games_router, "_POOL_TTL_SECONDS", 3600.0)
    await _ask(session_factory)
    assert len(walks) == 2 and not games_router._pool_flights


@pytest.mark.asyncio
async def test_a_delayed_request_reuses_the_pool_published_by_another(library, monkeypatch) -> None:
    session_factory, walks = library
    await _ask(session_factory)
    monkeypatch.setattr(games_router, "_POOL_TTL_SECONDS", 0.0)
    reached_depths = asyncio.Event()
    resume = asyncio.Event()
    load_depths = _QueueReader.load_depths

    async def delay_one_reader(self, pairs):
        if asyncio.current_task() is delayed:
            reached_depths.set()
            await resume.wait()
        return await load_depths(self, pairs)

    monkeypatch.setattr(_QueueReader, "load_depths", delay_one_reader)
    delayed = asyncio.create_task(_ask(session_factory))
    try:
        await asyncio.wait_for(reached_depths.wait(), timeout=5)
        await _ask(session_factory)
        await asyncio.gather(*list(games_router._pool_flights.values()))
        assert len(walks) == 2
    finally:
        resume.set()
        await delayed
    await asyncio.gather(*list(games_router._pool_flights.values()))
    assert len(walks) == 2


@pytest.mark.asyncio
async def test_a_failed_walk_behind_a_request_does_not_poison_the_next(library, monkeypatch) -> None:
    session_factory, walks = library
    monkeypatch.setattr(games_router, "_MIN_RECENT_DECISIONS", 40)
    monkeypatch.setattr(games_router, "_RECENT_DECISION_OVERFETCH", 1)
    first = await _ask(session_factory)
    monkeypatch.setattr(games_router, "_POOL_TTL_SECONDS", 0.0)

    async def broken(self):
        raise RuntimeError("database went away")

    with monkeypatch.context() as patched:
        patched.setattr(_QueueReader, "build_pool", broken)
        answer = await _ask(session_factory)
        assert answer["fens"] == first["fens"]
        await asyncio.gather(*list(games_router._pool_flights.values()), return_exceptions=True)
    assert games_router._pool_flights == {}

    # The pool it has is still served, and the next walk runs.
    again = await _ask(session_factory)
    assert again["fens"] == first["fens"]
    await asyncio.gather(*list(games_router._pool_flights.values()))
    assert len(walks) == 2


@pytest.mark.asyncio
async def test_depth_and_finished_games_come_back_in_one_read(library) -> None:
    session_factory, _ = library
    scope = _QueueScope(username="tester", color="both", time_class=None, min_depth=20,
                        min_user_rating=1000, review_band=False, excluded_fens=(), pair_target=10)
    pairs = [
        _DecisionPairTarget(parent_position_id=1, parent_fen="a", child_position_id=2, child_fen="b", ply=41),
        _DecisionPairTarget(parent_position_id=3, parent_fen="c", child_position_id=4, child_fen="d", ply=43),
    ]
    async with session_factory() as session:
        session.add_all([
            AnalysisResult(position_id=1, engine="stockfish-19", engine_version="19", depth=20, eval_cp=0,
                           best_move_uci="e2e4", best_move_san="e4", multipv_rank=1),
            AnalysisResult(position_id=1, engine="stockfish-19", engine_version="19", depth=34, eval_cp=0,
                           best_move_uci="e2e4", best_move_san="e4", multipv_rank=1),
            # Too shallow to count, and a second line is not a depth of the first.
            AnalysisResult(position_id=2, engine="stockfish-19", engine_version="19", depth=12, eval_cp=0,
                           best_move_uci="e2e4", best_move_san="e4", multipv_rank=1),
            AnalysisResult(position_id=3, engine="stockfish-19", engine_version="19", depth=30, eval_cp=0,
                           best_move_uci="e2e4", best_move_san="e4", multipv_rank=2),
            PositionOutcome(position_id=4, white_result=1, reason="checkmate"),
        ])
        await session.commit()
        statements: list[str] = []

        @event.listens_for(session.bind.sync_engine, "before_cursor_execute")
        def record(connection, cursor, statement, parameters, context, executemany):
            statements.append(statement)

        depths, exact = await _QueueReader(session, scope).load_depths(pairs)
        assert (depths, exact) == ({1: 34}, {4})
        assert len(statements) == 1, "depths and finished games took more than one round trip"

        # Graded at the review depth, the row in the band is the one that counts.
        banded = _QueueScope(**{**scope.__dict__, "review_band": True})
        depths, exact = await _QueueReader(session, banded).load_depths(pairs)
        assert (depths, exact) == ({1: 20}, {4})

        assert await _QueueReader(session, scope).load_depths([]) == ({}, set())
        assert len(statements) == 2, "an empty read went to the database"


def _postgres(clause) -> str:
    return str(clause.compile(dialect=postgresql.dialect()))


def test_seen_pairs_are_one_anti_join_whatever_their_number() -> None:
    # A row-wise NOT IN was two bind parameters a pair and a statement the
    # planner had never seen for every count: up to 116ms of planning.
    few = _pair_not_among(GamePosition.position_id, Position.id, [(1, 2)], dialect="postgresql")
    many = _pair_not_among(
        GamePosition.position_id, Position.id,
        [(index, index + 1) for index in range(4000)], dialect="postgresql",
    )
    assert _postgres(few) == _postgres(many)
    assert "NOT IN" not in _postgres(many)
    assert "unnest(" in _postgres(many) and "NOT (EXISTS" in _postgres(many)
    assert len(many.compile(dialect=postgresql.dialect()).params) == 2


def test_lists_of_values_are_one_array_parameter_on_postgres() -> None:
    inside = _member_of(Game.id, range(512), dialect="postgresql")
    outside = _not_member_of(Position.fen, [f"fen-{index}" for index in range(512)], dialect="postgresql")
    assert _postgres(inside) == _postgres(_member_of(Game.id, [1], dialect="postgresql"))
    assert "= ANY (" in _postgres(inside) and " IN (" not in _postgres(inside)
    assert "!= ALL (" in _postgres(outside) and "NOT IN" not in _postgres(outside)
    assert len(inside.compile(dialect=postgresql.dialect()).params) == 1
    assert len(outside.compile(dialect=postgresql.dialect()).params) == 1


def test_a_position_is_checked_for_validity_once(monkeypatch) -> None:
    # The queue asks this of every pair in its pool, several times a request.
    # Setting up a board each time was 2.4s of a 2.6s answer whose pool was
    # already cached, on the event loop.
    boards: list[str] = []
    real_board = games_router.chess.Board

    def counting_board(fen, *args, **kwargs):
        boards.append(fen)
        return real_board(fen, *args, **kwargs)

    monkeypatch.setattr(games_router.chess, "Board", counting_board)
    _is_storable_fen.cache_clear()
    valid = "r3q1k1/ppp3pp/8/2Q5/8/2n4P/PPPP1PP1/R1B3K1 b - -"
    stale_castling = "3rnkrb/qp1ppp2/8/p6p/8/P2N4/QP1PPP1P/3RRK1B b kq -"
    assert [_is_storable_fen(valid) for _ in range(50)] == [True] * 50
    assert [_is_storable_fen(stale_castling) for _ in range(50)] == [False] * 50
    assert len(boards) == 2
