"""Tests for the Study Coach and Grandmaster Playbook curriculum."""

from __future__ import annotations

from datetime import UTC, datetime

import chess
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.services.study_advisor import _match_opening_playbook, build_study_guide
from app.services.study_curriculum import PLAYBOOKS


@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


def test_all_playbook_tabiya_fens_are_valid_and_match_color() -> None:
    """Every opening/strategy tabiya FEN must parse cleanly in python-chess."""
    assert len(PLAYBOOKS) >= 12
    for pb in PLAYBOOKS:
        assert pb.core_ideas, f"{pb.id} must have core_ideas"
        assert pb.courses, f"{pb.id} must have at least one recommended course"
        if pb.tabiya_fen:
            # 4-field FENs expand cleanly when given halfmove/fullmove counters.
            board = chess.Board(f"{pb.tabiya_fen} 0 1")
            assert board.is_valid(), f"Invalid tabiya_fen in {pb.id}: {pb.tabiya_fen}"
            if pb.category == "opening" and pb.color in ("white", "black"):
                expected_turn = chess.WHITE if pb.color == "white" else chess.BLACK
                assert (
                    board.turn == expected_turn
                ), f"{pb.id} color is {pb.color} but FEN turn is {'white' if board.turn else 'black'}"


def test_match_opening_playbook_distinguishes_color_and_structure() -> None:
    assert _match_opening_playbook("black", "C45", "Scotch Game 3...exd4").id == "scotch_black"
    assert _match_opening_playbook("black", "D02", "Queen's Pawn Opening Zukertort Chigorin").id == "qgd_vs_d4_black"
    assert _match_opening_playbook("white", "D02", "London System").id == "london_white"
    assert _match_opening_playbook("white", "B13", "Caro Kann Defense Exchange Variation").id == "caro_kann_white"
    assert _match_opening_playbook("white", "B30", "Sicilian Defense Old Sicilian").id == "sicilian_white"
    assert _match_opening_playbook("white", "C50", "Italian Game").id == "italian_white"
    assert _match_opening_playbook("black", "C50", "Giuoco Piano Game").id == "italian_black"
    assert _match_opening_playbook("white", "B01", "Scandinavian Defense").id == "scandinavian_white"


@pytest.mark.asyncio
async def test_build_study_guide_surfaces_real_opening_leaks(db_session) -> None:
    """A player losing heavily in the Scotch and Chigorin gets those exact playbooks recommended."""
    now = datetime.now(UTC)
    games: list[Game] = []
    # 12 Black Scotch games: 2 wins, 10 losses -> 83.3% loss rate
    for i in range(12):
        res = "win" if i < 2 else "loss"
        games.append(
            Game(
                chesscom_game_url=f"https://chess.com/game/scotch-{i}",
                username="tester",
                white_username=f"opp-{i}",
                black_username="tester",
                user_color="black",
                result="0-1" if res == "win" else "1-0",
                user_result=res,
                time_class="rapid",
                white_rating=1700,
                black_rating=1700,
                pgn="1. e4 e5 2. Nf3 Nc6 3. d4 exd4 *",
                eco="C45",
                opening_name="Scotch Game 3...exd4 4.Nxd4 Nxd4 5.Qxd4",
                played_at=now,
            )
        )
    # 12 White Italian games: 9 wins, 3 losses -> 25% loss rate (not a leak)
    for i in range(12):
        res = "win" if i < 9 else "loss"
        games.append(
            Game(
                chesscom_game_url=f"https://chess.com/game/italian-{i}",
                username="tester",
                white_username="tester",
                black_username=f"opp2-{i}",
                user_color="white",
                result="1-0" if res == "win" else "0-1",
                user_result=res,
                time_class="rapid",
                white_rating=1720,
                black_rating=1700,
                pgn="1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *",
                eco="C50",
                opening_name="Giuoco Piano Game",
                played_at=now,
            )
        )
    db_session.add_all(games)
    await db_session.commit()

    guide = await build_study_guide(
        db_session,
        username="tester",
        time_class="rapid_blitz",
        min_user_rating=1000,
    )

    rec_ids = [item["playbook_id"] for item in guide["recommended"]]
    assert "scotch_black" in rec_ids
    assert "italian_white" not in rec_ids  # Winning 75%, low volume -> not flagged as leak
    assert guide["player_snapshot"]["latest_rating"] in (1700, 1720)
    assert len(guide["catalog"]) == len(PLAYBOOKS)
