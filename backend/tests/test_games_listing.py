"""The game list and its stats: one row per game, and one scan of the games."""

from datetime import UTC, datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import get_db
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.routers import games as games_router
from app.routers.games import game_stats, list_games


def build_game(
    game_id: int,
    played_at: datetime,
    *,
    username: str = "tester",
    user_color: str = "white",
    result: str = "1-0",
    time_class: str = "blitz",
    opening_name: str | None = "Italian Game",
) -> Game:
    if result == "1/2-1/2":
        user_result = "draw"
    elif (result == "1-0") == (user_color == "white"):
        user_result = "win"
    else:
        user_result = "loss"
    return Game(
        id=game_id,
        chesscom_game_url=f"https://chess.com/game/{game_id}",
        chesscom_game_id=str(game_id),
        username=username,
        white_username=username if user_color == "white" else "opponent",
        black_username="opponent" if user_color == "white" else username,
        user_color=user_color,
        result=result,
        user_result=user_result,
        time_class=time_class,
        time_control="600",
        white_rating=1200,
        black_rating=1200,
        pgn="1. e4 e5 1-0",
        eco="C50",
        opening_name=opening_name,
        played_at=played_at,
        num_moves=2,
    )


async def _library(games, visits=(), positions=()):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        session.add_all(Position(id=position_id, fen=fen, total_games=1) for position_id, fen in positions)
        session.add_all(games)
        await session.flush()
        session.add_all(
            GamePosition(game_id=game_id, position_id=position_id, ply=ply, move_uci="e2e4")
            for game_id, position_id, ply in visits
        )
        await session.commit()
    return engine, session_factory


def _statements(engine) -> list[str]:
    seen: list[str] = []

    @event.listens_for(engine.sync_engine, "before_cursor_execute")
    def record(connection, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    return seen


async def _list(session, **overrides):
    arguments = dict(
        username="tester", color="both", time_class=None, user_result=None, eco=None,
        opening_name=None, fen=None, page=1, per_page=20, session=session,
    )
    return await list_games(**{**arguments, **overrides})


@pytest.mark.asyncio
async def test_a_game_that_revisits_the_position_is_listed_and_counted_once() -> None:
    # Game 1 reaches the position three times (a repetition). Joined to its
    # visits it was three rows, which the old query grouped back into one.
    engine, session_factory = await _library(
        [
            build_game(1, datetime(2024, 1, 1, tzinfo=UTC)),
            build_game(2, datetime(2024, 1, 3, tzinfo=UTC)),
            build_game(3, datetime(2024, 1, 2, tzinfo=UTC)),
            build_game(4, datetime(2024, 1, 4, tzinfo=UTC), username="somebody-else"),
        ],
        visits=[(1, 1, 4), (1, 1, 8), (1, 1, 12), (2, 1, 4), (3, 2, 4), (4, 1, 4)],
        positions=[(1, "repeated"), (2, "elsewhere")],
    )
    async with session_factory() as session:
        seen = _statements(engine)
        page = await _list(session, fen="repeated")
        assert [game.id for game in page.games] == [2, 1]
        assert page.total == 2

        listing = [statement for statement in seen if "FROM games" in statement]
        # The position is resolved to its id once, and each game is asked
        # whether it visits it: no join to multiply games, nothing to regroup.
        assert sum("FROM positions" in statement for statement in seen) == 1
        assert not any("JOIN" in statement for statement in listing[:2])
        assert all("EXISTS" in statement for statement in listing[:2])
        assert not any("GROUP BY" in statement or "DISTINCT" in statement for statement in seen)
    await engine.dispose()


@pytest.mark.asyncio
async def test_a_position_filter_pages_through_games_newest_first() -> None:
    games = [build_game(game_id, datetime(2024, 1, game_id, tzinfo=UTC)) for game_id in range(1, 6)]
    # Two games share a timestamp: the id breaks the tie, the same way every page.
    games.append(build_game(6, datetime(2024, 1, 5, tzinfo=UTC)))
    engine, session_factory = await _library(
        games,
        visits=[(game_id, 1, 2) for game_id in range(1, 7)],
        positions=[(1, "shared")],
    )
    async with session_factory() as session:
        first = await _list(session, fen="shared", per_page=4)
        second = await _list(session, fen="shared", per_page=4, page=2)
        assert [game.id for game in first.games] == [6, 5, 4, 3]
        assert [game.id for game in second.games] == [2, 1]
        assert first.total == second.total == 6
    await engine.dispose()


@pytest.mark.asyncio
async def test_a_position_nobody_reached_lists_nothing_without_scanning_games() -> None:
    engine, session_factory = await _library([build_game(1, datetime(2024, 1, 1, tzinfo=UTC))])
    async with session_factory() as session:
        seen = _statements(engine)
        page = await _list(session, fen="never-on-the-board")
        assert page.games == [] and page.total == 0
        assert not any("FROM games" in statement for statement in seen)
    await engine.dispose()


@pytest.mark.asyncio
async def test_the_unfiltered_page_is_read_without_grouping() -> None:
    engine, session_factory = await _library(
        [build_game(game_id, datetime(2024, 1, game_id, tzinfo=UTC)) for game_id in range(1, 4)]
    )
    async with session_factory() as session:
        seen = _statements(engine)
        page = await _list(session, per_page=2)
        assert [game.id for game in page.games] == [3, 2]
        assert page.total == 3
        assert not any("GROUP BY" in statement or "DISTINCT" in statement for statement in seen)
        assert not any("game_positions" in statement for statement in seen[:2])
    await engine.dispose()


@pytest.mark.asyncio
async def test_game_stats_reads_the_games_once_and_keeps_every_number() -> None:
    games = [
        build_game(1, datetime(2024, 1, 1, tzinfo=UTC), result="1-0", time_class="blitz"),
        build_game(2, datetime(2024, 1, 2, tzinfo=UTC), result="0-1", time_class="blitz"),
        build_game(3, datetime(2024, 1, 3, tzinfo=UTC), result="1/2-1/2", time_class="blitz",
                   opening_name="French Defense"),
        build_game(4, datetime(2024, 1, 4, tzinfo=UTC), result="0-1", time_class="rapid",
                   user_color="black", opening_name=None),
        build_game(5, datetime(2024, 1, 5, tzinfo=UTC), result="1-0", time_class="rapid",
                   user_color="black", opening_name=None),
        build_game(6, datetime(2024, 1, 6, tzinfo=UTC), result="1-0", time_class="rapid",
                   user_color="black", opening_name="French Defense"),
        build_game(7, datetime(2024, 1, 7, tzinfo=UTC), username="somebody-else"),
    ]
    engine, session_factory = await _library(games)
    async with session_factory() as session:
        seen = _statements(engine)
        stats = await game_stats(username="tester", time_class=None, session=session)
        assert len(seen) == 1, "the games were scanned more than once"

        assert stats.model_dump() == {
            "total_games": 6,
            "win_rate": round(2 / 6, 4),
            "by_color": {
                "white": {"wins": 1, "losses": 1, "draws": 1},
                "black": {"wins": 1, "losses": 2, "draws": 0},
            },
            "by_time_class": {
                "blitz": {"games": 3, "wins": 1, "losses": 1, "draws": 1, "win_rate": round(1 / 3, 4)},
                "rapid": {"games": 3, "wins": 1, "losses": 2, "draws": 0, "win_rate": round(1 / 3, 4)},
            },
            # Most played first; games with no opening are one group, named on the way out.
            "by_opening": [
                {"opening_name": "French Defense", "games": 2},
                {"opening_name": "Italian Game", "games": 2},
                {"opening_name": "Unknown", "games": 2},
            ],
        }

        rapid = await game_stats(username="tester", time_class="rapid", session=session)
        assert rapid.total_games == 3
        assert list(rapid.by_time_class) == ["rapid"]
        assert rapid.by_color["white"].model_dump() == {"wins": 0, "losses": 0, "draws": 0}

        nobody = await game_stats(username="nobody", time_class=None, session=session)
        assert nobody.model_dump() == {
            "total_games": 0,
            "win_rate": 0.0,
            "by_color": {
                "white": {"wins": 0, "losses": 0, "draws": 0},
                "black": {"wins": 0, "losses": 0, "draws": 0},
            },
            "by_time_class": {},
            "by_opening": [],
        }
    await engine.dispose()


@pytest.mark.asyncio
async def test_game_stats_lists_only_the_ten_most_played_openings() -> None:
    games = []
    for index in range(12):
        # Opening 0 is played once, opening 11 twelve times.
        for copy in range(index + 1):
            game_id = len(games) + 1
            games.append(build_game(game_id, datetime(2024, 1, 1, tzinfo=UTC),
                                    opening_name=f"Opening {index:02d}"))
    engine, session_factory = await _library(games)
    async with session_factory() as session:
        stats = await game_stats(username="tester", time_class=None, session=session)
        assert [(row.opening_name, row.games) for row in stats.by_opening] == [
            (f"Opening {index:02d}", index + 1) for index in range(11, 1, -1)
        ]
    await engine.dispose()


@pytest.mark.parametrize("path", ["/api/games", "/api/games/opening-groups"])
@pytest.mark.parametrize("parameter,value", [("page", 0), ("per_page", 0), ("per_page", 101)])
def test_game_listings_reject_pages_outside_their_bounds(path, parameter, value) -> None:
    app = FastAPI()
    app.include_router(games_router.router, prefix="/api/games")

    async def no_database():
        yield None

    app.dependency_overrides[get_db] = no_database
    with TestClient(app) as client:
        response = client.get(path, params={"username": "tester", parameter: value})
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["query", parameter]


@pytest.mark.asyncio
async def test_opening_group_representative_respects_all_game_filters() -> None:
    played_at = datetime(2024, 1, 1, tzinfo=UTC)
    engine, session_factory = await _library([
        build_game(1, played_at),
        build_game(2, played_at, username="other"),
        build_game(3, played_at, user_color="black"),
        build_game(4, played_at, time_class="rapid"),
    ])
    async with session_factory() as session:
        groups = await games_router.game_opening_groups(
            username="tester", color="white", time_class="blitz", session=session,
        )
        [opening] = groups.openings
        assert opening.game_count == 1
        assert opening.representative_game_id == 1
    await engine.dispose()
