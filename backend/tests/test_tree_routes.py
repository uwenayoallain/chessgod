"""The filtered opening tree and the games behind a position, counted in games."""

from datetime import UTC, datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import get_db
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_move import PositionMove
from app.routers import tree as tree_router
from app.routers.tree import get_games_for_position, get_position_tree


def build_game(
    game_id: int,
    *,
    user_color: str = "white",
    result: str = "1-0",
    time_class: str = "blitz",
    day: int = 1,
    opponent_rating: int = 1200,
) -> Game:
    white = user_color == "white"
    return Game(
        id=game_id,
        chesscom_game_url=f"https://chess.com/game/{game_id}",
        chesscom_game_id=str(game_id),
        username="tester",
        white_username="tester" if white else "opponent",
        black_username="opponent" if white else "tester",
        user_color=user_color,
        result=result,
        user_result="win",
        time_class=time_class,
        time_control="600",
        white_rating=1500 if white else opponent_rating,
        black_rating=opponent_rating if white else 1500,
        pgn="pgn",
        played_at=datetime(2024, 1, day, tzinfo=UTC),
        num_moves=1,
    )


def edge(from_id: int, to_id: int, san: str, uci: str, *, move_number: int = 1, game_count: int = 1) -> PositionMove:
    return PositionMove(
        from_position_id=from_id, to_position_id=to_id, move_san=san, move_uci=uci,
        move_number=move_number, is_white_move=True, game_count=game_count,
        white_wins=0, draws=0, black_wins=0,
    )


async def _database():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.asyncio
async def test_filtered_totals_include_games_that_ended_at_the_position() -> None:
    engine, session_factory = await _database()
    async with session_factory() as session:
        session.add(Position(id=1, fen="terminal", total_games=2))
        session.add_all([
            build_game(1, result="1/2-1/2"),
            build_game(2, time_class="bullet"),
        ])
        await session.flush()
        session.add_all([
            GamePosition(game_id=1, position_id=1, ply=40),
            GamePosition(game_id=2, position_id=1, ply=30),
        ])
        await session.commit()

        node = await get_position_tree(fen="terminal", color="white", time_class="blitz", session=session)
        assert (node.total_games, node.white_wins, node.draws, node.black_wins) == (1, 0, 1, 0)
        assert node.moves == []
    await engine.dispose()


@pytest.mark.asyncio
async def test_a_move_is_counted_wherever_in_the_game_the_position_arose() -> None:
    # Two games reach the same position by different move orders, at ply 2 and
    # at ply 4, and play the same move from it. position_moves stores one ply
    # for the edge, and the filtered tree only counted the games at that ply.
    engine, session_factory = await _database()
    async with session_factory() as session:
        session.add_all([
            Position(id=1, fen="tabiya", total_games=2),
            Position(id=2, fen="after-nf3", total_games=3),
            Position(id=3, fen="other-parent", total_games=1),
        ])
        session.add_all([build_game(1), build_game(2, result="0-1"), build_game(3)])
        session.add(edge(1, 2, "Nf3", "g1f3", move_number=3, game_count=2))
        await session.flush()
        session.add_all([
            GamePosition(game_id=1, position_id=1, ply=2, move_uci="e7e5", move_san="e5"),
            GamePosition(game_id=1, position_id=2, ply=3, move_uci="g1f3", move_san="Nf3"),
            GamePosition(game_id=2, position_id=1, ply=4, move_uci="e7e5", move_san="e5"),
            GamePosition(game_id=2, position_id=2, ply=5, move_uci="g1f3", move_san="Nf3"),
            # Game 3 arrives at the same child by the same move at the stored
            # ply, but from another position: it is not a move from the tabiya.
            GamePosition(game_id=3, position_id=3, ply=2, move_uci="d7d6", move_san="d6"),
            GamePosition(game_id=3, position_id=2, ply=3, move_uci="g1f3", move_san="Nf3"),
        ])
        await session.commit()

        node = await get_position_tree(fen="tabiya", color="white", time_class=None, session=session)
        assert (node.total_games, node.white_wins, node.black_wins) == (2, 1, 1)
        [move] = node.moves
        assert (move.uci, move.san, move.resulting_fen) == ("g1f3", "Nf3", "after-nf3")
        assert (move.game_count, move.white_wins, move.black_wins) == (2, 1, 1)
    await engine.dispose()


@pytest.mark.asyncio
async def test_a_game_that_repeats_the_position_is_one_game() -> None:
    # One game shuffles back to the position twice more and plays the same
    # move each time: three visits and three edges, one game.
    engine, session_factory = await _database()
    async with session_factory() as session:
        session.add_all([
            Position(id=1, fen="shuffle", total_games=2),
            Position(id=2, fen="after-kh1", total_games=2),
            Position(id=3, fen="after-rd1", total_games=1),
        ])
        session.add_all([build_game(1, result="1/2-1/2"), build_game(2)])
        session.add_all([edge(1, 2, "Kh1", "g1h1", move_number=41, game_count=4),
                         edge(1, 3, "Rd1", "a1d1", move_number=41, game_count=1)])
        await session.flush()
        rows = []
        for ply in (40, 44, 48):
            rows.append(GamePosition(game_id=1, position_id=1, ply=ply, move_uci="h8g8", move_san="Kg8"))
            rows.append(GamePosition(game_id=1, position_id=2, ply=ply + 1, move_uci="g1h1", move_san="Kh1"))
        rows.append(GamePosition(game_id=2, position_id=1, ply=40, move_uci="h8g8", move_san="Kg8"))
        rows.append(GamePosition(game_id=2, position_id=3, ply=41, move_uci="a1d1", move_san="Rd1"))
        session.add_all(rows)
        await session.commit()

        node = await get_position_tree(fen="shuffle", color="white", time_class=None, session=session)
        assert (node.total_games, node.white_wins, node.draws) == (2, 1, 1)
        assert [(move.san, move.game_count, move.draws, move.white_wins) for move in node.moves] == [
            ("Kh1", 1, 1, 0),
            ("Rd1", 1, 0, 1),
        ]

        games = await get_games_for_position(fen="shuffle", page=1, per_page=50, session=session)
        assert games.total == 2
        assert sorted(game.id for game in games.games) == [1, 2]
    await engine.dispose()


@pytest.mark.asyncio
async def test_moves_are_ranked_by_the_filtered_games_before_the_cut() -> None:
    # Sixty-one moves Black plays often and one White played once. Cut to
    # sixty by everyone's counts, White's own move never made the list, and
    # the filtered tree came back with no moves at all.
    engine, session_factory = await _database()
    async with session_factory() as session:
        session.add(Position(id=1, fen="root", total_games=123))
        session.add(build_game(1, user_color="white", opponent_rating=1800))
        session.add(build_game(2, user_color="white", opponent_rating=1400, time_class="rapid"))
        session.add(build_game(3, user_color="black", opponent_rating=2600))
        await session.flush()
        rows = [
            GamePosition(game_id=1, position_id=1, ply=0),
            GamePosition(game_id=2, position_id=1, ply=0),
            GamePosition(game_id=3, position_id=1, ply=10),
        ]
        for index in range(61):
            position_id = 100 + index
            session.add(Position(id=position_id, fen=f"black-{index}", total_games=2))
            session.add(edge(1, position_id, f"B{index:02d}", f"black{index:02d}", game_count=2))
        session.add(Position(id=2, fen="white-own", total_games=3))
        session.add(edge(1, 2, "Zz1", "white-own-move", game_count=1))
        await session.flush()
        rows.append(GamePosition(game_id=1, position_id=2, ply=1, move_uci="white-own-move", move_san="Zz1"))
        rows.append(GamePosition(game_id=2, position_id=2, ply=1, move_uci="white-own-move", move_san="Zz1"))
        rows.append(GamePosition(game_id=3, position_id=2, ply=11, move_uci="white-own-move", move_san="Zz1"))
        session.add_all(rows)
        await session.commit()

        node = await get_position_tree(fen="root", color="white", time_class=None, session=session)
        [move] = node.moves
        assert (move.uci, move.game_count) == ("white-own-move", 2)
        # The opponents of the games counted, not of everyone who played the move.
        assert move.avg_opponent_rating == 1600.0

        rapid = await get_position_tree(fen="root", color="white", time_class="rapid", session=session)
        assert [(move.game_count, move.avg_opponent_rating) for move in rapid.moves] == [(1, 1400.0)]

        black = await get_position_tree(fen="root", color="black", time_class=None, session=session)
        assert [(move.game_count, move.avg_opponent_rating) for move in black.moves] == [(1, 2600.0)]
    await engine.dispose()


@pytest.mark.asyncio
async def test_a_move_with_no_stored_edge_is_still_a_move_played_here() -> None:
    engine, session_factory = await _database()
    async with session_factory() as session:
        session.add_all([Position(id=1, fen="here", total_games=1), Position(id=2, fen="there", total_games=1)])
        session.add(build_game(1))
        await session.flush()
        session.add_all([
            GamePosition(game_id=1, position_id=1, ply=6, move_uci="a7a6", move_san="a6"),
            GamePosition(game_id=1, position_id=2, ply=7, move_uci="b1c3", move_san="Nc3"),
        ])
        await session.commit()
        node = await get_position_tree(fen="here", color="white", time_class=None, session=session)
        [move] = node.moves
        assert (move.san, move.uci, move.resulting_fen, move.master_game_count) == ("Nc3", "b1c3", "there", None)
    await engine.dispose()


@pytest.mark.asyncio
async def test_games_for_a_position_are_ordered_before_they_are_paged() -> None:
    engine, session_factory = await _database()
    async with session_factory() as session:
        session.add(Position(id=1, fen="shared", total_games=6))
        # Inserted oldest first; games 5 and 6 share a day, so the id decides.
        days = {1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 5}
        session.add_all(build_game(game_id, day=day) for game_id, day in days.items())
        await session.flush()
        rows = [GamePosition(game_id=game_id, position_id=1, ply=2) for game_id in days]
        # The oldest game visits three times: it must not fill a page with itself.
        rows += [GamePosition(game_id=1, position_id=1, ply=6), GamePosition(game_id=1, position_id=1, ply=10)]
        session.add_all(rows)
        await session.commit()

        pages = [
            await get_games_for_position(fen="shared", page=page, per_page=4, session=session)
            for page in (1, 2, 3)
        ]
        assert [[game.id for game in page.games] for page in pages] == [[6, 5, 4, 3], [2, 1], []]
        assert [page.total for page in pages] == [6, 6, 6]

        nowhere = await get_games_for_position(fen="unknown", page=1, per_page=4, session=session)
        assert (nowhere.games, nowhere.total) == ([], 0)
    await engine.dispose()


@pytest.mark.parametrize("parameter,value", [("per_page", 0), ("per_page", 201), ("per_page", -5), ("page", 0)])
def test_games_for_a_position_reject_pages_outside_their_bounds(parameter, value) -> None:
    app = FastAPI()
    app.include_router(tree_router.router, prefix="/api/tree")

    async def no_database():
        yield None

    app.dependency_overrides[get_db] = no_database
    with TestClient(app) as client:
        response = client.get("/api/tree/games", params={"fen": "shared", parameter: value})
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["query", parameter]
