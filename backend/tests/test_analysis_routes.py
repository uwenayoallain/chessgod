from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.routers.analysis import get_evaluations, store_evaluations
from app.schemas.analysis import AnalysisEvaluationBatchIn, AnalysisEvaluationItemIn
from app.services.cache import get_shared_cache
from app.services.improvement import _CANDIDATE_CACHE_VERSION

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"
SECOND = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"
UNKNOWN = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -"


@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [{}, {"depth": 24}, {"eval_cp": 35}, {"pv_uci": "e2e4 e7e5"}])
async def test_retried_evaluations_preserve_freshness_and_skip_cache_invalidation(monkeypatch, changes):
    import app.routers.analysis as analysis_router

    invalidate = AsyncMock()
    monkeypatch.setattr(analysis_router, "invalidate_improvement_caches_for_positions", invalidate)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            original_time = datetime(2020, 1, 1, tzinfo=UTC)
            session.add(Position(id=1, fen=START))
            item = AnalysisEvaluationItemIn(fen=START, depth=22, eval_cp=30, best_move_uci="e2e4")
            row = AnalysisResult(position_id=1, analyzed_at=original_time,
                                 **item.model_dump(exclude={"fen"}))
            session.add(row)
            await session.commit()
            changed = bool(changes)
            item = AnalysisEvaluationItemIn(**(item.model_dump() | changes))
            before_upload = datetime.now(UTC)
            result = await store_evaluations(AnalysisEvaluationBatchIn(items=[item, item]), session=session)
            assert result == {"stored": int(changed), "skipped": 2-int(changed), "upgraded": int("depth" in changes)}
            if "depth" in changes:
                # A different depth is a different search, so it lands in its
                # own row and leaves the original reading untouched.
                assert row.analyzed_at == original_time
                deeper = await session.scalar(
                    select(AnalysisResult).where(AnalysisResult.depth == changes["depth"])
                )
                assert deeper is not None
                # SQLite hands back naive datetimes on reload.
                assert deeper.analyzed_at.replace(tzinfo=UTC) >= before_upload
                invalidate.assert_awaited_once_with(session, {1})
            elif changed:
                assert row.analyzed_at >= before_upload
                invalidate.assert_awaited_once_with(session, {1})
            else:
                assert row.analyzed_at == original_time
                invalidate.assert_not_awaited()
    finally:
        await engine.dispose()


@pytest.mark.parametrize("changes", [
    {"depth": 0}, {"depth": 999}, {"multipv_rank": 0},
    {"eval_cp": None}, {"eval_mate": 2}, {"fen": "not-a-fen"},
    {"best_move_uci": "e2e5"}, {"pv_uci": "d2d4 d7d5"},
    {"pv_uci": "e2e4 e7e4"}, {"engine": "stockfish-18"},
    {"eval_cp": None, "eval_mate": 0},
])
def test_evaluation_rejects_unusable_chess_evidence(changes) -> None:
    with pytest.raises(ValidationError):
        AnalysisEvaluationItemIn(**({"fen": START, "depth": 22, "eval_cp": 30, "best_move_uci": "e2e4"} | changes))


def test_evaluation_normalizes_fen_and_derives_notation_from_legal_moves() -> None:
    item = AnalysisEvaluationItemIn(fen=f"{START} 0 1", depth=22, eval_cp=30,
                                    best_move_uci="e2e4", best_move_san="wrong", pv_uci="e2e4 e7e5 g1f3")
    assert item.fen == START
    assert item.best_move_san == "e4"
    assert item.pv_san == "e4 e5 Nf3"


def test_evaluation_upload_has_a_bounded_batch_size() -> None:
    item = AnalysisEvaluationItemIn(fen=START, depth=22, eval_cp=30, best_move_uci="e2e4")
    with pytest.raises(ValidationError):
        AnalysisEvaluationBatchIn(items=[item] * 101)


@pytest.mark.asyncio
async def test_store_evaluations_bulk_upserts_existing_rows() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all([
            Position(id=1, fen=START, total_games=1, white_wins=1, draws=0, black_wins=0),
            Position(id=2, fen=SECOND, total_games=1, white_wins=1, draws=0, black_wins=0),
        ])
        session.add(
            AnalysisResult(
                position_id=1,
                depth=12,
                eval_cp=10,
                best_move_uci="e2e4",
                best_move_san="e4",
                multipv_rank=1,
            )
        )
        await session.commit()

        result = await store_evaluations(
            AnalysisEvaluationBatchIn(
                items=[
                    AnalysisEvaluationItemIn(fen=START, depth=20, eval_cp=30, best_move_uci="d2d4", multipv_rank=1),
                    AnalysisEvaluationItemIn(fen=SECOND, depth=20, eval_cp=40, best_move_uci="c7c5", multipv_rank=1),
                    AnalysisEvaluationItemIn(fen=UNKNOWN, depth=20, eval_cp=0, best_move_uci="g1f3", multipv_rank=1),
                ]
            ),
            session=session,
        )

        rows = list((await session.execute(
            select(AnalysisResult).order_by(AnalysisResult.position_id, AnalysisResult.depth)
        )).scalars().all())

        assert result == {"stored": 2, "skipped": 1, "upgraded": 1}
        # A deeper search is kept alongside the shallower one rather than
        # replacing it: grading a move needs both of its positions at a depth
        # they were both searched to, and that is not always the deepest.
        assert len(rows) == 3
        assert [(row.position_id, row.depth, row.best_move_uci) for row in rows] == [
            (1, 12, "e2e4"),
            (1, 20, "d2d4"),
            (2, 20, "c7c5"),
        ]

    await engine.dispose()


@pytest.mark.asyncio
async def test_store_evaluations_invalidates_only_affected_users() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                Position(id=1, fen=START, total_games=1),
                Position(id=2, fen=SECOND, total_games=1),
                Game(
                    id=1,
                    chesscom_game_url="https://chess.com/game/1",
                    username="alpha",
                    white_username="alpha",
                    black_username="opponent",
                    user_color="white",
                    result="1-0",
                    user_result="win",
                    time_class="rapid",
                    pgn="1. e4 1-0",
                    played_at=datetime(2026, 1, 1, tzinfo=UTC),
                ),
                Game(
                    id=2,
                    chesscom_game_url="https://chess.com/game/2",
                    username="beta",
                    white_username="beta",
                    black_username="opponent",
                    user_color="white",
                    result="1-0",
                    user_result="win",
                    time_class="rapid",
                    pgn="1. d4 1-0",
                    played_at=datetime(2026, 1, 1, tzinfo=UTC),
                ),
                GamePosition(game_id=1, position_id=1, ply=0),
                GamePosition(game_id=2, position_id=2, ply=0),
            ]
        )
        await session.commit()
        cache = get_shared_cache()
        alpha_key = f"improvement:candidates:v{_CANDIDATE_CACHE_VERSION}:alpha:both:rapid_blitz:80:18:1000"
        beta_key = f"improvement:candidates:v{_CANDIDATE_CACHE_VERSION}:beta:both:rapid_blitz:80:18:1000"
        await cache.set_json(alpha_key, ["stale"], ttl_seconds=60)
        await cache.set_json(beta_key, ["keep"], ttl_seconds=60)

        result = await store_evaluations(
            AnalysisEvaluationBatchIn(
                items=[
                    AnalysisEvaluationItemIn(
                        fen=START,
                        depth=22,
                        eval_cp=20,
                        best_move_uci="e2e4",
                        multipv_rank=1,
                    )
                ]
            ),
            session=session,
        )

        assert result == {"stored": 1, "skipped": 0, "upgraded": 0}
        assert await cache.get_json(alpha_key) is None
        assert await cache.get_json(beta_key) == ["keep"]

    await engine.dispose()


@pytest.mark.asyncio
async def test_get_evaluations_returns_persisted_line_data_for_cache_hydration() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add(Position(id=1, fen="fen-a", total_games=1, white_wins=1, draws=0, black_wins=0))
        session.add(
            AnalysisResult(
                position_id=1,
                depth=20,
                eval_cp=34,
                best_move_uci="d2d4",
                best_move_san="d4",
                pv_uci="d2d4 d7d5 c2c4",
                multipv_rank=1,
            )
        )
        await session.commit()

        result = await get_evaluations(fens="fen-a", min_depth=20, session=session)

        assert result["fen-a"].depth == 20
        assert result["fen-a"].best_move_uci == "d2d4"
        assert result["fen-a"].pv_uci == "d2d4 d7d5 c2c4"
        assert result["fen-a"].multipv_rank == 1

    await engine.dispose()
