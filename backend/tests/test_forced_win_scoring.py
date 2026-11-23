from datetime import UTC, datetime

import chess
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.analysis import AnalysisResult
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_move import PositionMove
from app.models.position_outcome import PositionOutcome
from app.engine_contract import DECISIVE_CP, MAX_PAIR_DEPTH_GAP
from app.services.improvement import _load_candidates, _TREND_ROWS_SQL
from app.services.mistakes import find_mistakes


@pytest.mark.asyncio
@pytest.mark.parametrize("black", [False, True])
@pytest.mark.parametrize("scenario", ["large_cp", "slower_mate", "terminal", "stalemate", "lost_win", "shorter_loss", "finite_loss"])
async def test_mate_outcome_scoring_is_consistent_across_learning_surfaces(black, scenario):
    forced_loss = scenario in {"shorter_loss", "finite_loss"}
    board = chess.Board("8/8/8/8/4q3/5k2/8/7K w - - 0 1" if forced_loss else "6k1/4Q3/6K1/8/8/8/8/8 w - - 0 1")
    if black:
        board = board.mirror()
    best = "e2e1" if black else "e7e8"
    played = ("e2d1" if black else "e7d8") if scenario == "terminal" else ("e2f2" if black else "e7f7")
    if scenario == "stalemate":
        played = "e2f3" if black else "e7f6"
    if forced_loss:
        best = "h8h7" if black else "h1h2"
        played = "h8g8" if black else "h1g1"
    parent_fen = board.fen()
    best_san = board.san(chess.Move.from_uci(best))
    played_san = board.san(chess.Move.from_uci(played))
    board.push_uci(played)
    assert board.is_valid()
    assert board.is_checkmate() == (scenario == "terminal")
    assert board.is_stalemate() == (scenario == "stalemate")
    is_error = scenario in {"stalemate", "lost_win"}
    color = "black" if black else "white"
    sign = -1 if black else 1
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            session.add_all([Position(id=1, fen=parent_fen), Position(id=2, fen=board.fen())])
            session.add(Game(
                id=1, chesscom_game_url="https://chess.com/game/forced-win",
                username="forced-win", white_username="white", black_username="black",
                user_color=color, result="0-1" if black else "1-0", user_result="win",
                time_class="rapid", time_control="600", white_rating=1200, black_rating=1200,
                pgn="", played_at=datetime(2026, 1, 1, tzinfo=UTC),
            ))
            ply = 2 if black else 1
            session.add_all([
                GamePosition(game_id=1, position_id=1, ply=ply-1),
                GamePosition(game_id=1, position_id=2, ply=ply, move_uci=played, move_san=played_san),
                PositionMove(from_position_id=1, to_position_id=2, move_uci=best, move_san=best_san,
                             move_number=ply, is_white_move=not black, game_count=1, master_game_count=100),
                AnalysisResult(position_id=1, depth=24, best_move_uci=best, best_move_san=best_san,
                               eval_cp=None if scenario == "slower_mate" or forced_loss else sign*3000,
                               eval_mate=-sign*20 if forced_loss else sign if scenario == "slower_mate" else None),
            ])
            if scenario in {"terminal", "stalemate"}:
                session.add(PositionOutcome(position_id=2, white_result=0 if is_error else sign,
                                            reason="stalemate" if is_error else "checkmate"))
            else:
                reply = next(iter(board.legal_moves))
                session.add(AnalysisResult(position_id=2, depth=24,
                                           eval_cp=-sign*3000 if scenario == "finite_loss" else 0 if is_error else None,
                                           eval_mate=None if is_error or scenario == "finite_loss" else -sign if forced_loss else sign*20,
                                           best_move_uci=reply.uci(), best_move_san=board.san(reply)))
            await session.commit()
            candidates = await _load_candidates(session, username="forced-win", color=color,
                                                time_class="rapid_blitz", threshold_cp=80, min_depth=18)
            assert len(candidates) == int(is_error)
            trends = (await session.execute(_TREND_ROWS_SQL, {
                "username": "forced-win", "color": color, "time_class": "rapid_blitz",
                "min_depth": 18, "min_user_rating": 1000,
                "max_pair_depth_gap": MAX_PAIR_DEPTH_GAP,
            })).mappings().all()
            assert len(trends) == 1
            assert trends[0]["analyzed"] == 1
            # +30 pawns is past DECISIVE_CP, so the drop to a draw is measured from the cap.
            assert trends[0]["cp_loss"] == (DECISIVE_CP if is_error else 0)
            mistakes = await find_mistakes(session, "forced-win", color=color, min_occurrences=1)
            assert len(mistakes) == int(is_error)
    finally:
        await engine.dispose()
