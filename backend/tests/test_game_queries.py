from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.routers.games import (
    game_opening_groups,
    game_stats,
    get_opening_preview,
    list_games,
)


def build_game(
    game_id: int,
    url: str,
    opening_name: str,
    played_at: datetime,
    *,
    eco: str = "C20",
    user_color: str = "white",
    result: str = "1-0",
    time_class: str = "blitz",
) -> Game:
    if result == "1/2-1/2":
        user_result = "draw"
    elif result == "1-0":
        user_result = "win"
    else:
        user_result = "loss"
    return Game(
        id=game_id,
        chesscom_game_url=url,
        chesscom_game_id=str(game_id),
        username="tester",
        white_username="tester",
        black_username="opponent",
        user_color=user_color,
        result=result,
        user_result=user_result,
        time_class=time_class,
        time_control="600",
        white_rating=1200,
        black_rating=1200,
        pgn='[Event "Test"]\n[Site "?"]\n[Date "2024.01.01"]\n[Round "-"]\n[White "tester"]\n[Black "opponent"]\n[Result "1-0"]\n\n1. e4 e5 1-0',
        eco=eco,
        opening_name=opening_name,
        played_at=played_at,
        num_moves=2,
    )


@pytest.mark.asyncio
async def test_list_games_filters_by_position_and_opening() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                Position(
                    id=1,
                    fen="start",
                    total_games=2,
                    white_wins=2,
                    draws=0,
                    black_wins=0,
                ),
                Position(
                    id=2,
                    fen="fen-a",
                    total_games=1,
                    white_wins=1,
                    draws=0,
                    black_wins=0,
                ),
                Position(
                    id=3,
                    fen="fen-b",
                    total_games=1,
                    white_wins=1,
                    draws=0,
                    black_wins=0,
                ),
            ]
        )
        session.add_all(
            [
                build_game(
                    1,
                    "https://chess.com/game/1",
                    "King Pawn Game",
                    datetime(2024, 1, 2, tzinfo=UTC),
                ),
                build_game(
                    2,
                    "https://chess.com/game/2",
                    "Queen Pawn Game",
                    datetime(2024, 1, 1, tzinfo=UTC),
                    eco="D00",
                ),
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
                    game_id=2, position_id=3, ply=1, move_san="d4", move_uci="d2d4"
                ),
            ]
        )
        await session.commit()

        by_fen = await list_games(
            username="tester",
            color="both",
            time_class=None,
            user_result=None,
            eco=None,
            opening_name=None,
            fen="fen-a",
            page=1,
            per_page=20,
            session=session,
        )
        assert [game.id for game in by_fen.games] == [1]

        by_opening = await list_games(
            username="tester",
            color="both",
            time_class=None,
            user_result=None,
            eco=None,
            opening_name="Queen Pawn Game",
            fen=None,
            page=1,
            per_page=20,
            session=session,
        )
        assert [game.id for game in by_opening.games] == [2]

    await engine.dispose()


@pytest.mark.asyncio
async def test_opening_groups_and_preview_use_most_recent_game() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                build_game(
                    1,
                    "https://chess.com/game/1",
                    "Italian Game",
                    datetime(2024, 1, 1, tzinfo=UTC),
                ),
                build_game(
                    2,
                    "https://chess.com/game/2",
                    "Italian Game",
                    datetime(2024, 1, 3, tzinfo=UTC),
                ),
                build_game(
                    3,
                    "https://chess.com/game/3",
                    "French Defense",
                    datetime(2024, 1, 2, tzinfo=UTC),
                    eco="C00",
                ),
            ]
        )
        await session.commit()

        groups = await game_opening_groups(
            username="tester",
            color="both",
            time_class=None,
            page=1,
            per_page=10,
            session=session,
        )
        assert [opening.opening_name for opening in groups.openings] == [
            "Italian Game",
            "French Defense",
        ]
        assert groups.openings[0].representative_game_id == 2

        preview = await get_opening_preview(
            username="tester",
            opening_name="Italian Game",
            eco=None,
            color="both",
            time_class=None,
            session=session,
        )
        assert preview.representative_game.id == 2
        assert preview.opening_name == "Italian Game"

    await engine.dispose()


@pytest.mark.asyncio
async def test_game_stats_returns_result_breakdown_per_time_class() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                build_game(
                    1,
                    "https://chess.com/game/1",
                    "Italian Game",
                    datetime(2024, 1, 1, tzinfo=UTC),
                    result="1-0",
                    time_class="blitz",
                ),
                build_game(
                    2,
                    "https://chess.com/game/2",
                    "Italian Game",
                    datetime(2024, 1, 2, tzinfo=UTC),
                    result="0-1",
                    time_class="blitz",
                ),
                build_game(
                    3,
                    "https://chess.com/game/3",
                    "French Defense",
                    datetime(2024, 1, 3, tzinfo=UTC),
                    result="1/2-1/2",
                    time_class="blitz",
                ),
                build_game(
                    4,
                    "https://chess.com/game/4",
                    "Caro-Kann",
                    datetime(2024, 1, 4, tzinfo=UTC),
                    result="1-0",
                    time_class="rapid",
                ),
            ]
        )
        await session.commit()

        stats = await game_stats(username="tester", time_class=None, session=session)

        assert stats.total_games == 4
        assert stats.by_time_class["blitz"].games == 3
        assert stats.by_time_class["blitz"].wins == 1
        assert stats.by_time_class["blitz"].losses == 1
        assert stats.by_time_class["blitz"].draws == 1
        assert stats.by_time_class["rapid"].games == 1
        assert stats.by_time_class["rapid"].wins == 1
        assert stats.by_time_class["rapid"].losses == 0
        assert stats.by_time_class["rapid"].draws == 0

    await engine.dispose()
