"""A move is graded by differencing two searches, so both need a shared depth.

Every evaluation the browser produces is uploaded, at whatever depth it ran:
the library crawl at the review depth, a quick look at 18, an interactive study
of one position at 30. Reading each position's *deepest* row and subtracting
charges the difference between two searches to the player. These tests pin the
pairing rule instead: measure at a depth both sides reached, and leave the
decision unmeasured while they have none.
"""

from datetime import UTC, datetime

import chess
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_move import PositionMove
from app.engine_contract import MAX_PAIR_DEPTH_GAP
from app.services.improvement import _load_candidates, _TREND_ROWS_SQL
from app.services.mistakes import find_mistakes

BEST_MOVE = "e2e4"
PLAYED_MOVE = "a2a3"


def _boards() -> tuple[str, str, str]:
    board = chess.Board()
    played_san = board.san(chess.Move.from_uci(PLAYED_MOVE))
    best_san = board.san(chess.Move.from_uci(BEST_MOVE))
    board.push_uci(PLAYED_MOVE)
    return board.fen(), played_san, best_san


async def _candidates(
    *,
    parent_evals: dict[int, int],
    child_evals: dict[int, int],
    parent_best_by_depth: dict[int, str] | None = None,
) -> list[dict]:
    """One white decision, evaluated at the given depth/centipawn readings."""

    child_fen, played_san, best_san = _boards()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            session.add_all(
                [
                    Position(id=1, fen=chess.Board().fen()),
                    Position(id=2, fen=child_fen),
                    Game(
                        id=1,
                        chesscom_game_url="https://chess.com/game/depth-pairing",
                        username="depths",
                        white_username="depths",
                        black_username="opponent",
                        user_color="white",
                        result="0-1",
                        user_result="loss",
                        time_class="rapid",
                        time_control="600",
                        white_rating=1200,
                        black_rating=1200,
                        pgn="",
                        played_at=datetime(2026, 1, 1, tzinfo=UTC),
                    ),
                    GamePosition(game_id=1, position_id=1, ply=0),
                    GamePosition(
                        game_id=1,
                        position_id=2,
                        ply=1,
                        move_uci=PLAYED_MOVE,
                        move_san=played_san,
                    ),
                ]
            )
            session.add_all(
                AnalysisResult(
                    position_id=1,
                    depth=depth,
                    eval_cp=eval_cp,
                    best_move_uci=(parent_best_by_depth or {}).get(depth, BEST_MOVE),
                    best_move_san=(
                        played_san
                        if (parent_best_by_depth or {}).get(depth) == PLAYED_MOVE
                        else best_san
                    ),
                )
                for depth, eval_cp in parent_evals.items()
            )
            session.add_all(
                AnalysisResult(
                    position_id=2,
                    depth=depth,
                    eval_cp=eval_cp,
                    best_move_uci="e7e5",
                    best_move_san="e5",
                )
                for depth, eval_cp in child_evals.items()
            )
            await session.commit()
            return await _load_candidates(
                session,
                username="depths",
                color="white",
                time_class="rapid_blitz",
                threshold_cp=80,
                min_depth=18,
            )
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_a_deeper_look_at_one_side_does_not_invent_a_mistake() -> None:
    # Opening the parent on the board searched it to depth 30 and it changed
    # its mind by 270cp. The move itself lost 10cp at the depth both sides were
    # crawled to, and that is what the decision is worth.
    candidates = await _candidates(
        parent_evals={22: 30, 30: 300}, child_evals={22: 20}
    )
    assert candidates == []


@pytest.mark.asyncio
async def test_a_real_loss_is_measured_at_the_deepest_shared_depth() -> None:
    candidates = await _candidates(
        parent_evals={22: 30, 30: 300}, child_evals={22: 20, 30: -50}
    )
    assert [item["eval_drop_cp"] for item in candidates] == [350]


@pytest.mark.asyncio
async def test_a_single_finished_depth_apart_still_counts() -> None:
    # Stockfish reports the depth it finished on, so a crawl asked for 22 can
    # store 23. Refusing that would throw away most of the corpus.
    candidates = await _candidates(parent_evals={23: 300}, child_evals={22: 20})
    assert [item["eval_drop_cp"] for item in candidates] == [280]


@pytest.mark.asyncio
async def test_sides_searched_far_apart_are_left_unmeasured() -> None:
    # Nothing here says whether the player lost 280cp or the extra eight plies
    # did. The decision waits for the shallower side to be deepened.
    candidates = await _candidates(parent_evals={30: 300}, child_evals={22: 20})
    assert candidates == []


@pytest.mark.asyncio
async def test_the_deepest_shared_search_decides_whether_it_was_a_mistake() -> None:
    # At depth 22 the engine would have played something else; at depth 30, with
    # both sides searched that far, it agrees with the move. Judging the pair
    # before choosing it would report the shallower disagreement as a mistake.
    candidates = await _candidates(
        parent_evals={22: 300, 30: 300},
        child_evals={22: 20, 30: 20},
        parent_best_by_depth={30: PLAYED_MOVE},
    )
    assert candidates == []


async def _every_surface(
    *, parent_evals: dict[int, int], child_evals: dict[int, int]
) -> tuple[list[dict], list[dict], list]:
    """The same decision as read by the drill queue, the trend series and the
    recurring-mistake list. All three difference two searches, so all three have
    to agree about which depths may be differenced."""

    child_fen, played_san, best_san = _boards()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            session.add_all(
                [
                    Position(id=1, fen=chess.Board().fen()),
                    Position(id=2, fen=child_fen),
                    Game(
                        id=1,
                        chesscom_game_url="https://chess.com/game/depth-surfaces",
                        username="depths",
                        white_username="depths",
                        black_username="opponent",
                        user_color="white",
                        result="0-1",
                        user_result="loss",
                        time_class="rapid",
                        time_control="600",
                        white_rating=1200,
                        black_rating=1200,
                        pgn="",
                        played_at=datetime(2026, 1, 1, tzinfo=UTC),
                    ),
                    GamePosition(game_id=1, position_id=1, ply=0),
                    GamePosition(
                        game_id=1,
                        position_id=2,
                        ply=1,
                        move_uci=PLAYED_MOVE,
                        move_san=played_san,
                    ),
                    # find_mistakes only looks at positions master play knows,
                    # and only at moves outside its top three.
                    PositionMove(
                        from_position_id=1,
                        to_position_id=2,
                        move_uci=BEST_MOVE,
                        move_san=best_san,
                        move_number=1,
                        is_white_move=True,
                        game_count=1,
                        master_game_count=100,
                    ),
                ]
            )
            session.add_all(
                AnalysisResult(
                    position_id=1,
                    depth=depth,
                    eval_cp=eval_cp,
                    best_move_uci=BEST_MOVE,
                    best_move_san=best_san,
                )
                for depth, eval_cp in parent_evals.items()
            )
            session.add_all(
                AnalysisResult(
                    position_id=2,
                    depth=depth,
                    eval_cp=eval_cp,
                    best_move_uci="e7e5",
                    best_move_san="e5",
                )
                for depth, eval_cp in child_evals.items()
            )
            await session.commit()
            candidates = await _load_candidates(
                session,
                username="depths",
                color="white",
                time_class="rapid_blitz",
                threshold_cp=80,
                min_depth=18,
            )
            trends = (
                await session.execute(
                    _TREND_ROWS_SQL,
                    {
                        "username": "depths",
                        "color": "white",
                        "time_class": "rapid_blitz",
                        "threshold_cp": 80,
                        "min_depth": 18,
                        "min_user_rating": 1000,
                        "max_pair_depth_gap": MAX_PAIR_DEPTH_GAP,
                    },
                )
            ).mappings().all()
            mistakes = await find_mistakes(
                session, "depths", color="white", min_occurrences=1
            )
            return candidates, list(trends), mistakes
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_every_learning_surface_refuses_a_mismatched_measurement() -> None:
    candidates, trends, mistakes = await _every_surface(
        parent_evals={30: 300}, child_evals={22: 20}
    )
    assert candidates == []
    assert mistakes == []
    # The move still belongs to the series; it is simply not measured yet.
    assert len(trends) == 1
    assert trends[0]["analyzed"] == 0
    assert trends[0]["cp_loss"] == 0


@pytest.mark.asyncio
async def test_every_learning_surface_measures_a_shared_depth() -> None:
    candidates, trends, mistakes = await _every_surface(
        parent_evals={22: 300}, child_evals={22: 20}
    )
    assert [item["eval_drop_cp"] for item in candidates] == [280]
    assert [mistake.eval_drop_cp for mistake in mistakes] == [280]
    assert len(trends) == 1
    assert trends[0]["analyzed"] == 1
    assert trends[0]["cp_loss"] == 280
