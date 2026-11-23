from datetime import UTC, datetime

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from sqlalchemy.exc import IntegrityError

from app.models.analysis import AnalysisResult
from app.models.cloud_evaluation import CloudEvaluation
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_move import PositionMove
from app.services.mistakes import _chunked, compute_cp_loss, find_mistakes


def game() -> Game:
    return Game(
        id=1,
        chesscom_game_url="https://chess.com/game/1",
        chesscom_game_id="1",
        username="tester",
        white_username="tester",
        black_username="opponent",
        user_color="white",
        result="0-1",
        user_result="loss",
        time_class="rapid",
        time_control="600",
        white_rating=1200,
        black_rating=1250,
        pgn='[Event "Test"]\n[White "tester"]\n[Black "opponent"]\n[Result "0-1"]\n\n1. d4 0-1',
        eco="C20",
        opening_name="King Pawn Game",
        played_at=datetime(2024, 1, 1, tzinfo=UTC),
        num_moves=1,
    )


def test_compute_cp_loss_flips_for_black_to_move() -> None:
    assert compute_cp_loss(80, -20, mover_is_white=True) == 100
    assert compute_cp_loss(-80, 20, mover_is_white=False) == 100


def test_chunked_splits_large_id_lists() -> None:
    assert list(_chunked([1, 2, 3, 4, 5], 2)) == [[1, 2], [3, 4], [5]]


@pytest.mark.asyncio
async def test_find_mistakes_ignores_other_evaluation_providers() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                Position(id=1, fen="start", total_games=1, white_wins=0, draws=0, black_wins=1),
                Position(id=2, fen="after-e4", total_games=1, white_wins=0, draws=0, black_wins=1),
                Position(id=3, fen="after-d4", total_games=1, white_wins=0, draws=0, black_wins=1),
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
                    game_count=1,
                    white_wins=1,
                    draws=0,
                    black_wins=0,
                    master_game_count=100,
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
                    draws=0,
                    black_wins=1,
                ),
            ]
        )
        session.add(game())
        session.add_all(
            [
                GamePosition(game_id=1, position_id=1, ply=0, move_san=None, move_uci=None),
                GamePosition(game_id=1, position_id=3, ply=1, move_san="d4", move_uci="d2d4"),
            ]
        )
        # The parent's only evaluation comes from the cloud, which lives in its
        # own table since migration 018 and can never be differenced against our
        # own search of the child.
        session.add_all(
            [
                CloudEvaluation(
                    position_id=1,
                    engine="lichess-cloud",
                    depth=22,
                    eval_cp=80,
                    best_move_uci="e2e4",
                    best_move_san="e4",
                    multipv_rank=1,
                ),
                AnalysisResult(
                    position_id=3,
                    engine="stockfish-19",
                    depth=22,
                    eval_cp=-20,
                    best_move_uci="g8f6",
                    best_move_san="Nf6",
                    multipv_rank=1,
                ),
            ]
        )
        await session.commit()

        mistakes = await find_mistakes(
            session,
            "tester",
            color="white",
            min_occurrences=1,
            threshold_cp=50,
            min_depth=18,
        )

        assert mistakes == []

    await engine.dispose()


@pytest.mark.asyncio
async def test_another_engines_evaluation_cannot_be_stored_alongside_the_contract() -> None:
    """The separation is enforced by the database, not by every reader remembering.

    Before migration 018 a foreign evaluation sat in ``analysis_results`` and
    was kept out of results only by each query filtering on the engine name. One
    query forgetting the filter would have differenced another engine's search
    against ours and called the gap a mistake.
    """

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add(Position(id=1, fen="start", total_games=1))
        await session.commit()
        session.add(
            AnalysisResult(
                position_id=1, engine="lichess-cloud", depth=22, eval_cp=80,
                best_move_uci="e2e4", best_move_san="e4", multipv_rank=1,
            )
        )
        with pytest.raises(IntegrityError):
            await session.commit()
        await session.rollback()

    async with session_factory() as session:
        # A superseded Stockfish build is refused for the same reason.
        session.add(
            AnalysisResult(
                position_id=1, engine="stockfish", engine_version="Stockfish 17.1",
                depth=22, eval_cp=80, best_move_uci="e2e4", best_move_san="e4",
                multipv_rank=1,
            )
        )
        with pytest.raises(IntegrityError):
            await session.commit()

    await engine.dispose()


@pytest.mark.asyncio
async def test_find_mistakes_ignores_master_top3_moves() -> None:
    """A move that IS in the master top-3 must not be reported."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add_all([
            Position(id=1, fen="start", total_games=2, white_wins=0, draws=0, black_wins=2),
            Position(id=2, fen="after-e4", total_games=0, white_wins=0, draws=0, black_wins=0),
            Position(id=3, fen="after-d4", total_games=2, white_wins=0, draws=0, black_wins=2),
        ])
        # Both e4 AND d4 are in master moves — d4 is rank-2, so it IS in top-3
        session.add_all([
            PositionMove(from_position_id=1, to_position_id=2,
                         move_san="e4", move_uci="e2e4", move_number=1, is_white_move=True,
                         game_count=0, white_wins=0, draws=0, black_wins=0, master_game_count=1000),
            PositionMove(from_position_id=1, to_position_id=3,
                         move_san="d4", move_uci="d2d4", move_number=1, is_white_move=True,
                         game_count=2, white_wins=0, draws=0, black_wins=2, master_game_count=800),
        ])
        session.add_all([
            AnalysisResult(position_id=1, engine="stockfish-19", engine_version="19", depth=24,
                           eval_cp=50, best_move_uci="e2e4", best_move_san="e4", multipv_rank=1),
            AnalysisResult(position_id=3, engine="stockfish-19", engine_version="19", depth=24,
                           eval_cp=-200, best_move_uci="a1a1", best_move_san="a1", multipv_rank=1),
        ])
        session.add_all([
            Game(id=1, chesscom_game_url="u1", chesscom_game_id="1", username="tester",
                 white_username="tester", black_username="opp", user_color="white",
                 result="0-1", user_result="loss", time_class="rapid", time_control="600",
                 white_rating=1200, black_rating=1200, pgn="", eco="D00", opening_name="T",
                 played_at=datetime(2024, 1, 1, tzinfo=UTC), num_moves=1),
            Game(id=2, chesscom_game_url="u2", chesscom_game_id="2", username="tester",
                 white_username="tester", black_username="opp", user_color="white",
                 result="0-1", user_result="loss", time_class="rapid", time_control="600",
                 white_rating=1200, black_rating=1200, pgn="", eco="D00", opening_name="T",
                 played_at=datetime(2024, 1, 2, tzinfo=UTC), num_moves=1),
        ])
        session.add_all([
            GamePosition(game_id=1, position_id=1, ply=0),
            GamePosition(game_id=1, position_id=3, ply=1, move_san="d4", move_uci="d2d4"),
            GamePosition(game_id=2, position_id=1, ply=0),
            GamePosition(game_id=2, position_id=3, ply=1, move_san="d4", move_uci="d2d4"),
        ])
        await session.commit()

        mistakes = await find_mistakes(session, "tester", color="white",
                                       threshold_cp=50, min_occurrences=1)
        assert mistakes == [], "master-deviation check must suppress d4 (it is in top-3)"
    await engine.dispose()


@pytest.mark.asyncio
async def test_find_mistakes_respects_min_occurrences() -> None:
    """Mistake played only once is hidden when min_occurrences=2, visible at 1."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add_all([
            Position(id=1, fen="start", total_games=1, white_wins=0, draws=0, black_wins=1),
            Position(id=2, fen="after-e4", total_games=0, white_wins=0, draws=0, black_wins=0),
            Position(id=3, fen="after-d4", total_games=1, white_wins=0, draws=0, black_wins=1),
        ])
        session.add_all([
            PositionMove(from_position_id=1, to_position_id=2,
                         move_san="e4", move_uci="e2e4", move_number=1, is_white_move=True,
                         game_count=0, white_wins=0, draws=0, black_wins=0, master_game_count=1000),
            PositionMove(from_position_id=1, to_position_id=3,
                         move_san="d4", move_uci="d2d4", move_number=1, is_white_move=True,
                         game_count=1, white_wins=0, draws=0, black_wins=1),
        ])
        session.add_all([
            AnalysisResult(position_id=1, engine="stockfish-19", engine_version="19", depth=24,
                           eval_cp=None, eval_mate=3, best_move_uci="e2e4", best_move_san="e4", multipv_rank=1),
            AnalysisResult(position_id=3, engine="stockfish-19", engine_version="19", depth=24,
                           eval_cp=-200, best_move_uci="a1a1", best_move_san="a1", multipv_rank=1),
        ])
        session.add(Game(
            id=1, chesscom_game_url="u1", chesscom_game_id="1", username="tester",
            white_username="tester", black_username="opp", user_color="white",
            result="0-1", user_result="loss", time_class="rapid", time_control="600",
            white_rating=1200, black_rating=1200, pgn="", eco="D00", opening_name="T",
            played_at=datetime(2024, 1, 1, tzinfo=UTC), num_moves=1,
        ))
        session.add_all([
            GamePosition(game_id=1, position_id=1, ply=0),
            GamePosition(game_id=1, position_id=3, ply=1, move_san="d4", move_uci="d2d4"),
        ])
        await session.commit()

        assert await find_mistakes(session, "tester", color="white", min_occurrences=2) == []
        result = await find_mistakes(session, "tester", color="white", min_occurrences=1)
        assert len(result) == 1
        assert result[0].eval_drop_cp == 2170

        # Adjacent searches can disagree even when the player chose the exact
        # best move. Search instability is not a mistake by the player.
        await session.execute(
            update(AnalysisResult)
            .where(AnalysisResult.position_id == 1)
            .values(best_move_uci="d2d4", best_move_san="d4")
        )
        assert await find_mistakes(session, "tester", color="white", min_occurrences=1) == []


@pytest.mark.asyncio
async def test_find_mistakes_black_perspective() -> None:
    """For a black player, cp_loss = child_eval_cp - parent_eval_cp (rising eval hurts black)."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        # ply 0 = start, ply 1 = white e4, ply 2 = black e5 (the mistake)
        session.add_all([
            Position(id=1, fen="startpos", total_games=2, white_wins=2, draws=0, black_wins=0),
            Position(id=10, fen="after-e4", total_games=2, white_wins=2, draws=0, black_wins=0),
            Position(id=11, fen="after-e4-e5", total_games=2, white_wins=2, draws=0, black_wins=0),
        ])
        # c5 is the master move; e5 is NOT in top-3
        session.add_all([
            PositionMove(from_position_id=10, to_position_id=99,
                         move_san="c5", move_uci="c7c5", move_number=2, is_white_move=False,
                         game_count=0, white_wins=0, draws=0, black_wins=0, master_game_count=500),
            PositionMove(from_position_id=10, to_position_id=11,
                         move_san="e5", move_uci="e7e5", move_number=2, is_white_move=False,
                         game_count=2, white_wins=2, draws=0, black_wins=0),
        ])
        # After e4: eval=0 (balanced). After e4-e5: eval=+80 (white better).
        # Black's cp_loss = child(80) - parent(0) = 80 > 50.
        session.add_all([
            AnalysisResult(position_id=10, engine="stockfish-19", engine_version="19", depth=24,
                           eval_cp=0, best_move_uci="c7c5", best_move_san="c5", multipv_rank=1),
            AnalysisResult(position_id=11, engine="stockfish-19", engine_version="19", depth=24,
                           eval_cp=80, best_move_uci="a1a1", best_move_san="a1", multipv_rank=1),
        ])
        session.add_all([
            Game(id=1, chesscom_game_url="u1", chesscom_game_id="1", username="tester",
                 white_username="opp", black_username="tester", user_color="black",
                 result="1-0", user_result="loss", time_class="rapid", time_control="600",
                 white_rating=1200, black_rating=1200, pgn="", eco="C20", opening_name="T",
                 played_at=datetime(2024, 1, 1, tzinfo=UTC), num_moves=2),
            Game(id=2, chesscom_game_url="u2", chesscom_game_id="2", username="tester",
                 white_username="opp", black_username="tester", user_color="black",
                 result="1-0", user_result="loss", time_class="rapid", time_control="600",
                 white_rating=1200, black_rating=1200, pgn="", eco="C20", opening_name="T",
                 played_at=datetime(2024, 1, 2, tzinfo=UTC), num_moves=2),
        ])
        session.add_all([
            GamePosition(game_id=1, position_id=1, ply=0),
            GamePosition(game_id=1, position_id=10, ply=1, move_san="e4", move_uci="e2e4"),
            GamePosition(game_id=1, position_id=11, ply=2, move_san="e5", move_uci="e7e5"),
            GamePosition(game_id=2, position_id=1, ply=0),
            GamePosition(game_id=2, position_id=10, ply=1, move_san="e4", move_uci="e2e4"),
            GamePosition(game_id=2, position_id=11, ply=2, move_san="e5", move_uci="e7e5"),
        ])
        await session.commit()

        mistakes = await find_mistakes(session, "tester", color="black",
                                       threshold_cp=50, min_occurrences=2)
        assert len(mistakes) == 1
        m = mistakes[0]
        assert m.parent_fen == "after-e4"
        assert m.user_move.uci == "e7e5"
        assert m.eval_drop_cp == 80
    await engine.dispose()
