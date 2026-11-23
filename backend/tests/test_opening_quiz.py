"""The opening quiz asks the player's own positions against the master book."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_move import PositionMove
from app.services.opening_quiz import build_opening_quiz

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"
E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"
E4_C5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -"
E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -"
NEXT = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -"


@pytest_asyncio.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        yield db
    await engine.dispose()


def master(from_id: int, to_id: int, uci: str, san: str, games: int) -> PositionMove:
    return PositionMove(
        from_position_id=from_id, to_position_id=to_id, move_uci=uci, move_san=san,
        move_number=2, is_white_move=True, master_game_count=games,
    )


async def seed(session) -> None:
    session.add_all([
        Position(id=1, fen=START), Position(id=2, fen=E4),
        Position(id=3, fen=E4_C5, master_total=1000, master_opening_name="Sicilian Defense"),
        Position(id=4, fen=E4_E5, master_total=1000, master_opening_name="King's Pawn Game"),
        Position(id=5, fen=NEXT),
    ])
    session.add_all([
        master(3, 5, "g1f3", "Nf3", 800), master(3, 5, "b1c3", "Nc3", 180),
        master(3, 5, "f1c4", "Bc4", 20),  # 2%: a sideline, not book
        master(4, 5, "g1f3", "Nf3", 900), master(4, 5, "f1c4", "Bc4", 100),
    ])

    def game(game_id: int, reply: tuple[str, str, int], move: tuple[str, str]) -> None:
        session.add(Game(
            id=game_id, chesscom_game_url=f"g{game_id}", username="saint", white_username="saint",
            black_username="x", user_color="white", result="1-0", user_result="win",
            time_class="rapid", pgn="", played_at=datetime(2026, 9, 1, tzinfo=UTC),
        ))
        reply_uci, reply_san, position_id = reply
        session.add_all([
            GamePosition(game_id=game_id, ply=0, position_id=1),
            GamePosition(game_id=game_id, ply=1, position_id=2, move_uci="e2e4", move_san="e4"),
            GamePosition(game_id=game_id, ply=2, position_id=position_id, move_uci=reply_uci, move_san=reply_san),
            GamePosition(game_id=game_id, ply=3, position_id=5, move_uci=move[0], move_san=move[1]),
        ])

    # Against the Sicilian the player always plays Bc4 (not book); against
    # 1…e5 they play Nf3, the main line, more often.
    for game_id in range(1, 3):
        game(game_id, ("c7c5", "c5", 3), ("f1c4", "Bc4"))
    for game_id in range(3, 7):
        game(game_id, ("e7e5", "e5", 4), ("g1f3", "Nf3"))
    await session.commit()


@pytest.mark.asyncio
async def test_the_quiz_asks_where_the_player_leaves_the_book_first(session):
    await seed(session)
    quiz = await build_opening_quiz(session, username="saint", color="white", time_class="rapid")
    assert [item.fen for item in quiz] == [E4_C5, E4_E5]
    sicilian = quiz[0]
    assert (sicilian.ply, sicilian.occurrences, sicilian.side_to_move) == (2, 2, "white")
    assert sicilian.last_move_uci == "c7c5"
    assert sicilian.opening_name == "Sicilian Defense"
    assert not sicilian.usual_move_in_book
    assert [(move.san, move.share) for move in sicilian.book_moves] == [("Nf3", 0.8), ("Nc3", 0.18)]
    assert [(move.san, move.count) for move in sicilian.user_moves] == [("Bc4", 2)]
    assert quiz[1].usual_move_in_book


@pytest.mark.asyncio
async def test_positions_where_it_is_the_opponents_move_are_never_asked(session):
    await seed(session)
    assert await build_opening_quiz(session, username="saint", color="black") == []
