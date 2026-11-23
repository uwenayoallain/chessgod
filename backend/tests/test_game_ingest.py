from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.models.position_outcome import PositionOutcome
from app.services.game_ingest import insert_game
from app.services.pgn_parser import parse_game_pgn
from app.services.tree_builder import update_tree_from_game


def build_game(
    url: str,
    game_id: str,
    user_color: str,
    result: str,
    time_class: str,
    *,
    termination: str | None = None,
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
        termination=termination,
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
            build_game(
                "https://chess.com/game/1",
                "1",
                "white",
                "1-0",
                "blitz",
                termination="timeout",
            ),
        )
        assert duplicate_id is None
        await session.commit()
        first_game = await session.scalar(
            select(Game).where(Game.chesscom_game_url == "https://chess.com/game/1")
        )
        assert first_game is not None
        assert first_game.termination == "timeout"

        second_id = await insert_game(
            session,
            build_game("https://chess.com/game/2", "2", "black", "0-1", "rapid"),
        )
        assert second_id is not None
        await session.commit()

        total = await session.scalar(select(func.count()).select_from(Game))
        assert total == 2

    await engine.dispose()


@pytest.mark.asyncio
async def test_new_game_import_records_its_terminal_board_without_an_engine() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            game = build_game("https://chess.com/game/mate", "mate", "black", "0-1", "rapid")
            game.pgn = '[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1'
            parsed = parse_game_pgn(game.pgn)
            game_id = await insert_game(session, game)
            assert game_id is not None
            await update_tree_from_game(session, game_id, parsed, "0-1")
            await session.commit()
            outcomes = list(await session.scalars(select(PositionOutcome)))
            assert len(outcomes) == 1
            assert outcomes[0].white_result == -1
            assert outcomes[0].reason == "checkmate"
    finally:
        await engine.dispose()
