from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.services.game_ingest import insert_game


def build_game(
    url: str,
    game_id: str,
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
        chesscom_game_url=url,
        chesscom_game_id=game_id,
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
async def test_insert_game_skips_duplicates_and_allows_new_inserts() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        game_id = await insert_game(
            session,
            build_game("https://chess.com/game/1", "1", "white", "1-0", "blitz"),
        )
        assert game_id is not None
        await session.commit()

        duplicate_id = await insert_game(
            session,
            build_game("https://chess.com/game/1", "1", "white", "1-0", "blitz"),
        )
        assert duplicate_id is None
        await session.commit()

        second_id = await insert_game(
            session,
            build_game("https://chess.com/game/2", "2", "black", "0-1", "rapid"),
        )
        assert second_id is not None
        await session.commit()

        total = await session.scalar(select(func.count()).select_from(Game))
        assert total == 2

    await engine.dispose()
