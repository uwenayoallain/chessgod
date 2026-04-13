from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_move import PositionMove
from app.routers.tree import get_position_tree


def build_game(
    game_id: int,
    url: str,
    user_color: str,
    result: str,
    time_class: str,
) -> Game:
    if result == "1/2-1/2":
        user_result = "draw"
    elif (result == "1-0" and user_color == "white") or (
        result == "0-1" and user_color == "black"
    ):
        user_result = "win"
    else:
        user_result = "loss"

    return Game(
        id=game_id,
        chesscom_game_url=url,
        chesscom_game_id=url.rsplit("/", 1)[-1],
        username="tester",
        white_username="tester" if user_color == "white" else "opponent",
        black_username="opponent" if user_color == "white" else "tester",
        user_color=user_color,
        result=result,
        user_result=user_result,
        time_class=time_class,
        time_control="600",
        white_rating=1200,
        black_rating=1200,
        pgn="pgn",
        eco=None,
        opening_name=None,
        played_at=datetime(2024, 1, 1, tzinfo=UTC),
        num_moves=1,
    )


@pytest.mark.asyncio
async def test_tree_filters_by_color_and_time_class() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        start = Position(
            id=1,
            fen="start",
            total_games=3,
            white_wins=1,
            draws=1,
            black_wins=1,
        )
        pos_e4 = Position(
            id=2, fen="e4", total_games=2, white_wins=1, draws=0, black_wins=1
        )
        pos_d4 = Position(
            id=3, fen="d4", total_games=1, white_wins=0, draws=1, black_wins=0
        )

        session.add_all([start, pos_e4, pos_d4])
        session.add_all(
            [
                build_game(1, "https://chess.com/game/1", "white", "1-0", "blitz"),
                build_game(2, "https://chess.com/game/2", "black", "0-1", "rapid"),
                build_game(3, "https://chess.com/game/3", "white", "1/2-1/2", "blitz"),
            ]
        )
        session.add_all(
            [
                GamePosition(
                    game_id=1, position_id=1, ply=0, move_san=None, move_uci=None
                ),
                GamePosition(
                    game_id=1, position_id=2, ply=1, move_san="e4", move_uci="e2e4"
                ),
                GamePosition(
                    game_id=2, position_id=1, ply=0, move_san=None, move_uci=None
                ),
                GamePosition(
                    game_id=2, position_id=2, ply=1, move_san="e4", move_uci="e2e4"
                ),
                GamePosition(
                    game_id=3, position_id=1, ply=0, move_san=None, move_uci=None
                ),
                GamePosition(
                    game_id=3, position_id=3, ply=1, move_san="d4", move_uci="d2d4"
                ),
            ]
        )
        session.add_all(
            [
                PositionMove(
                    from_position_id=1,
                    to_position_id=2,
                    move_san="e4",
                    move_uci="e2e4",
                    move_number=1,
                    is_white_move=True,
                    game_count=2,
                    white_wins=1,
                    draws=0,
                    black_wins=1,
                ),
                PositionMove(
                    from_position_id=1,
                    to_position_id=3,
                    move_san="d4",
                    move_uci="d2d4",
                    move_number=1,
                    is_white_move=True,
                    game_count=1,
                    white_wins=0,
                    draws=1,
                    black_wins=0,
                ),
            ]
        )
        await session.commit()

        filtered = await get_position_tree(
            fen="start",
            color="white",
            time_class=None,
            session=session,
        )
        assert filtered.total_games == 2
        assert filtered.white_wins == 1
        assert filtered.draws == 1
        assert filtered.black_wins == 0
        assert sorted(move.game_count for move in filtered.moves) == [1, 1]

        rapid_only = await get_position_tree(
            fen="start",
            color="both",
            time_class="rapid",
            session=session,
        )
        assert rapid_only.total_games == 1
        assert rapid_only.black_wins == 1
        assert len(rapid_only.moves) == 1
        assert rapid_only.moves[0].uci == "e2e4"

    await engine.dispose()
