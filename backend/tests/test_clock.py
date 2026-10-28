from datetime import UTC, datetime

import chess
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.services import clock
from app.utils.fen import normalize_fen


def test_the_main_control_prefers_rapid_with_enough_games() -> None:
    assert clock.main_control([("600", "rapid", 50), ("180", "blitz", 400)]) == ("600", "rapid")
    assert clock.main_control([("600", "rapid", 5), ("180", "blitz", 400)]) == ("180", "blitz")
    assert clock.main_control([("1/86400", "daily", 50)]) is None
    assert clock.parse_control("600+5") == (600.0, 5.0)
    assert clock.parse_control("-") is None


def _summary(**extra) -> dict:
    return {"games": 100, "mistakes": 200, "initial_seconds": 600.0, "left_in_losses": 360.0,
            "mistakes_with_half_clock": 0.87, "mistakes_in_time_trouble": 0.01, **extra}


def test_the_verdict_names_unused_time_and_time_trouble() -> None:
    assert clock.verdict(_summary()) == "unused"
    assert clock.verdict(_summary(mistakes_in_time_trouble=0.3)) == "time_trouble"
    assert clock.verdict(_summary(left_in_losses=60.0)) == "balanced"
    assert clock.verdict(_summary(mistakes=10)) == "insufficient"


@pytest.mark.asyncio
async def test_big_mistakes_are_timed_against_the_clock_left_before_the_move() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    # Knights out and back: 24 legal plies, past the opening's 20.
    sans = ["Nf3", "Nf6", "Ng1", "Ng8"] * 6
    board = chess.Board()
    fens = [normalize_fen(board.fen())]
    ucis: list[str | None] = [None]
    for san in sans:
        ucis.append(board.push_san(san).uci())
        fens.append(normalize_fen(board.fen()))
    ids: dict[str, int] = {}
    for fen in fens:
        ids.setdefault(fen, len(ids) + 1)

    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add_all(Position(id=position_id, fen=fen) for fen, position_id in ids.items())
        session.add(Game(
            id=1, chesscom_game_url="u1", chesscom_game_id="1", username="tester", white_username="tester",
            black_username="b", user_color="white", result="0-1", user_result="loss", time_class="rapid",
            time_control="600", white_rating=1500, black_rating=1500, pgn="-",
            played_at=datetime(2026, 9, 1, tzinfo=UTC), num_moves=len(sans),
        ))
        await session.flush()
        for ply, (fen, uci) in enumerate(zip(fens, ucis, strict=True)):
            session.add(GamePosition(game_id=1, position_id=ids[fen], ply=ply, move_uci=uci,
                                     think_seconds=4.0 if ply else None,
                                     clock_seconds_after=600.0 - 10 * ply if ply else None))
        # The same four positions repeat; the drop is the knight's return at ply 23.
        session.add_all(
            AnalysisResult(position_id=position_id, depth=20, eval_cp=0, best_move_uci="g1f3",
                           best_move_san="Nf3", multipv_rank=1)
            for position_id in ids.values()
        )
        await session.commit()
        before = await clock.build_clock(session, username="tester", min_user_rating=1000)
    await engine.dispose()

    assert (before["time_control"], before["games"], before["losses"]) == ("600", 1, 1)
    # Plies 21 and 23 are White's moves past the opening; nothing was lost.
    assert before["moves"] == 2
    assert before["mistakes"] == 0
    assert before["left_in_losses"] == 600.0 - 10 * 23
    assert sum(band["moves"] for band in before["by_think"]) == 2
