from datetime import UTC, datetime

import chess
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_move import PositionMove
from app.routers.games import unanalyzed_fens
from app.services.improvement import build_improvement_plan
from app.services.mistakes import find_mistakes
from app.services.position_outcomes import store_position_outcomes, terminal_outcome

PARENT = "k7/8/1QK5/8/8/8/8/8 w - -"
MATE = "k7/1Q6/2K5/8/8/8/8/8 b - -"
STALEMATE = "k7/2Q5/2K5/8/8/8/8/8 b - -"


def test_terminal_outcomes_are_board_facts_not_history_dependent_draw_claims():
    assert terminal_outcome(MATE) == (1, "checkmate")
    assert terminal_outcome(chess.Board(MATE + " 0 1").mirror().fen()) == (-1, "checkmate")
    assert terminal_outcome(STALEMATE) == (0, "stalemate")
    assert terminal_outcome(PARENT + " 100 90") is None
    assert terminal_outcome("invalid") is None
    assert terminal_outcome("8/8/8/8/8/8/8/8 w - -") is None


@pytest.mark.asyncio
@pytest.mark.parametrize("child,move,loss", [(STALEMATE, "b6c7", 500), (MATE, "b6b7", 0)])
@pytest.mark.parametrize("black", [False, True])
async def test_terminal_children_complete_coverage_and_are_not_engine_jobs(child, move, loss, black):
    parent, best, score, ply = PARENT, "b6b7", 500, 60
    if black:
        parent = " ".join(chess.Board(parent + " 0 1").mirror().fen().split()[:4])
        child = " ".join(chess.Board(child + " 0 1").mirror().fen().split()[:4])
        original_move = chess.Move.from_uci(move)
        move = chess.Move(chess.square_mirror(original_move.from_square), chess.square_mirror(original_move.to_square)).uci()
        best, score, ply = "b3b2", -500, 61
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            session.add_all([Position(id=1, fen=parent), Position(id=2, fen=child)])
            session.add(PositionMove(
                from_position_id=1, to_position_id=2, move_san="best", move_uci=best,
                move_number=1, is_white_move=not black, game_count=1,
                white_wins=1, draws=0, black_wins=0, master_game_count=1,
            ))
            session.add(Game(
                id=1, chesscom_game_url="https://chess.com/game/terminal", username="tester",
                white_username="opponent" if black else "tester", black_username="tester" if black else "opponent",
                user_color="black" if black else "white",
                result=("0-1" if black else "1-0") if loss == 0 else "1/2-1/2", user_result="win" if loss == 0 else "draw",
                time_class="rapid", white_rating=1200, black_rating=1200,
                pgn="", played_at=datetime(2026, 1, 1, tzinfo=UTC),
            ))
            session.add_all([
                GamePosition(game_id=1, position_id=1, ply=ply),
                GamePosition(game_id=1, position_id=2, ply=ply + 1, move_uci=move,
                             move_san=chess.Board(parent + " 0 1").san(chess.Move.from_uci(move))),
                AnalysisResult(position_id=1, depth=22, eval_cp=score,
                               best_move_uci=best, best_move_san="Qb2#" if black else "Qb7#", pv_uci=best),
            ])
            await session.flush()
            assert await store_position_outcomes(session, [(2, child), (1, parent)]) == 1
            assert await store_position_outcomes(session, [(2, child)]) == 0
            await session.commit()
            queue = await unanalyzed_fens(username="tester", color="both", limit=2, session=session)
            assert queue["fens"] == []
            assert queue["analyzed_count"] == queue["candidate_count"] == 2
            plan = await build_improvement_plan(session, username="tester")
            assert plan.summary.analyzed_decisions == plan.summary.total_decisions == 1
            assert len(plan.drills) == int(loss > 0)
            if loss:
                assert plan.drills[0].eval_drop_cp == loss
                mistakes = await find_mistakes(session, "tester", color="both", min_occurrences=1)
                assert len(mistakes) == 1
                assert mistakes[0].eval_drop_cp == loss
            # No depth, PV, or engine identity was fabricated for the final board.
            assert await session.scalar(select(func.count()).select_from(AnalysisResult)) == 1
    finally:
        await engine.dispose()
