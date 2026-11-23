from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
import chess
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from sqlalchemy import func, select, update

from app.models.analysis import AnalysisResult
from app.models.drill_progress import DrillAttempt, DrillProgress
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.schemas.improvement import (
    DrillAttemptIn,
    DrillCardOut,
    DrillFollowUpOut,
    PhaseCoverageOut,
)
from app.services.improvement import (
    _CANDIDATE_CACHE_VERSION,
    build_follow_up,
    build_improvement_plan,
    compare_intent,
    compose_session,
    classify_pattern,
    next_review,
    move_san,
    invalidate_improvement_caches,
    _stop_advice,
    _retention,
    record_drill_attempt,
    structure_signature,
    trend_status,
)


START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"
AFTER_NF3 = "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq -"
AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"


@pytest.mark.asyncio
@pytest.mark.parametrize("old_pv,new_pv", [
    ("e2e4 e7e5 g1f3", "e2e4 c7c5 g1f3"),
    ("e2e4 e7e5 g1f3", "e2e4 e7e5 b1c3"),
    ("e2e4", "e2e4 e7e5 g1f3"),
    ("e2e4 e7e5 g1f3", "e2e4"),
])
async def test_changed_continuation_does_not_record_a_learning_failure(old_pv, new_pv):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            session.add(Position(id=1, fen=START))
            session.add(AnalysisResult(position_id=1, depth=24, eval_cp=20,
                                       best_move_uci="e2e4", best_move_san="e4", pv_uci=new_pv))
            await session.commit()
            shown = build_follow_up(START, old_pv)
            payload = DrillAttemptIn(
                username="tester", position_id=1, expected_move_uci="e2e4",
                played_move_uci="e2e4", pattern_key="calculation",
                expected_follow_up=shown,
                follow_up_move_uci=shown.best_move_uci if shown else None,
            )
            with pytest.raises(ValueError, match="continuation is stale"):
                await record_drill_attempt(session, payload)
            assert await session.scalar(select(DrillProgress)) is None
            assert await session.scalar(select(DrillAttempt)) is None

            # A refreshed lesson is scored normally against server evidence.
            current = build_follow_up(START, new_pv)
            refreshed = payload.model_copy(update={
                "expected_follow_up": current,
                "follow_up_move_uci": current.best_move_uci if current else None,
            })
            result = await record_drill_attempt(session, refreshed)
            assert result.correct is True
            assert result.attempts == 1
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_empty_due_reviews_do_not_scan_game_history(monkeypatch):
    import app.services.improvement as improvement
    from sqlalchemy import text

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        # Fail if the expensive historical query is reached at all.
        monkeypatch.setattr(improvement, "_CANDIDATES_SQL", text("SELECT * FROM unexpected_history_scan"))
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            assert await improvement._load_candidates(
                session, username="no-reviews", color="both", time_class="rapid_blitz",
                threshold_cp=80, min_depth=18, review_due_at=datetime.now(UTC),
            ) == []
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_due_review_survives_candidate_cutoff_and_refreshes_without_cache_expiry(monkeypatch):
    import app.services.improvement as improvement

    monkeypatch.setattr(improvement, "_CANDIDATE_SCAN_LIMIT", 1)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            after_nf6 = chess.Board(AFTER_E4 + " 0 1")
            after_nf6.push_uci("g8f6")
            session.add_all([
                Position(id=1, fen=START), Position(id=2, fen=AFTER_NF3),
                Position(id=3, fen=AFTER_E4), Position(id=4, fen=after_nf6.fen()),
            ])
            for game_id, color, parent, child, ply, move, san in [
                (1, "white", 1, 2, 1, "g1f3", "Nf3"),
                (2, "black", 3, 4, 2, "g8f6", "Nf6"),
            ]:
                session.add(Game(
                    id=game_id, chesscom_game_url=f"https://chess.com/game/{game_id}",
                    username="cutoff", white_username="cutoff", black_username="cutoff",
                    user_color=color, result="1-0", user_result="loss", time_class="rapid",
                    white_rating=1200, black_rating=1200, pgn="",
                    played_at=datetime(2026, 1, game_id, tzinfo=UTC),
                ))
                session.add_all([
                    GamePosition(game_id=game_id, position_id=parent, ply=ply-1),
                    GamePosition(game_id=game_id, position_id=child, ply=ply, move_uci=move, move_san=san),
                ])
            for position_id, cp, best, san in [
                (1, 20, "e2e4", "e4"), (2, -300, "d7d5", "d5"),
                (3, 20, "e7e5", "e5"), (4, 200, "e4e5", "e5"),
            ]:
                session.add(AnalysisResult(
                    position_id=position_id, engine="stockfish-19", depth=22,
                    eval_cp=cp, best_move_uci=best, best_move_san=san, multipv_rank=1,
                ))
            progress = DrillProgress(
                username="cutoff", position_id=3, expected_move_uci="e7e5",
                attempts=1, correct_attempts=0, streak=0,
                due_at=datetime.now(UTC)-timedelta(days=1),
            )
            session.add(progress)
            await session.commit()
            plan = await build_improvement_plan(session, username="cutoff")
            assert {card.position_id for card in plan.drills} == {1, 3}
            assert next(card for card in plan.drills if card.position_id == 3).queue_source == "review"
            assert plan.summary.candidate_positions_is_lower_bound is True

            original_execute = session.execute
            candidate_reads = []

            async def track_execute(statement, *args, **kwargs):
                if statement is improvement._CANDIDATES_SQL:
                    candidate_reads.append(statement)
                return await original_execute(statement, *args, **kwargs)

            monkeypatch.setattr(session, "execute", track_execute)
            warm = await build_improvement_plan(session, username="cutoff")
            assert {card.position_id for card in warm.drills} == {1, 3}
            assert candidate_reads == []

            # New progress changes the signature even if the due date stays.
            progress.attempts += 1
            await session.commit()
            await build_improvement_plan(session, username="cutoff")
            assert len(candidate_reads) == 1
            candidate_reads.clear()

            # Engine/import invalidation also invalidates review selections.
            await invalidate_improvement_caches("cutoff")
            await build_improvement_plan(session, username="cutoff")
            assert len(candidate_reads) == 2

            # Review state is live even while the expensive candidate list is cached.
            progress.due_at = datetime.now(UTC)+timedelta(days=1)
            await session.commit()
            refreshed = await build_improvement_plan(session, username="cutoff")
            assert {card.position_id for card in refreshed.drills} == {1}

            progress.due_at = datetime.now(UTC)-timedelta(days=1)
            progress.expected_move_uci = "d7d5"
            await session.commit()
            stale = await build_improvement_plan(session, username="cutoff")
            assert {card.position_id for card in stale.drills} == {1}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("follow_up", [False, True])
@pytest.mark.parametrize("black_to_move", [False, True])
@pytest.mark.parametrize("answer,correct", [("f7g7", True), ("f7e6", False), ("f7f6", False)])
async def test_drill_accepts_alternative_checkmates_not_stalemates_or_checks(
    follow_up: bool, black_to_move: bool, answer: str, correct: bool,
) -> None:
    board = chess.Board(
        "6k1/4Q3/6K1/8/8/8/8/8 w - - 0 1" if follow_up
        else "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1"
    )
    pv = ["e7f7", "g8h8", "f7f8"] if follow_up else ["f7f8"]
    if black_to_move:
        board = board.mirror()
        def mirror(uci: str) -> str:
            move = chess.Move.from_uci(uci)
            return chess.Move(chess.square_mirror(move.from_square), chess.square_mirror(move.to_square)).uci()
        pv = [mirror(move) for move in pv]
        answer = mirror(answer)
    assert board.is_valid()
    answer_board = board.copy()
    if follow_up:
        for move in pv[:2]:
            answer_board.push_uci(move)
    answer_board.push_uci(answer)
    assert answer_board.is_checkmate() == correct

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            session.add(Position(id=1, fen=board.fen()))
            session.add(AnalysisResult(
                position_id=1, engine="stockfish-19", engine_version="19",
                depth=24, eval_mate=(-1 if black_to_move else 1) * (2 if follow_up else 1),
                best_move_uci=pv[0], best_move_san=board.san(chess.Move.from_uci(pv[0])),
                pv_uci=" ".join(pv), multipv_rank=1,
            ))
            await session.commit()
            result = await record_drill_attempt(session, DrillAttemptIn(
                username="tester", position_id=1, expected_move_uci=pv[0],
                played_move_uci=pv[0] if follow_up else answer,
                follow_up_move_uci=answer if follow_up else None,
                pattern_key="calculation",
            ))
            await session.commit()
            assert result.correct == correct
            assert result.follow_up_correct == (correct if follow_up else None)
            progress = await session.scalar(select(DrillProgress))
            assert progress.correct_attempts == int(correct)
            assert progress.streak == int(correct)
    finally:
        await engine.dispose()


def test_retention_distinguishes_new_learning_lapses_and_spaced_recall() -> None:
    result = _retention([
        DrillProgress(attempts=0, correct_attempts=0, streak=0),
        DrillProgress(attempts=2, correct_attempts=0, streak=0),
        DrillProgress(attempts=2, correct_attempts=1, streak=0),
        DrillProgress(attempts=1, correct_attempts=1, streak=1),
        DrillProgress(attempts=2, correct_attempts=2, streak=2),
    ])
    assert result.tracked_positions == 4
    assert result.retained_positions == 1
    assert result.lapsed_positions == 1
    assert result.retention_rate == 0.25
    assert _retention([]).retention_rate is None


@pytest.mark.asyncio
async def test_an_upload_keeps_the_queue_counts_but_drops_the_plan() -> None:
    from app.services.cache import get_shared_cache

    cache = get_shared_cache()
    plan_key = f"improvement:candidates:v{_CANDIDATE_CACHE_VERSION}:saint:both:rapid_blitz:80:18:1000"
    counts_key = "coverage:v3:saint:both:rapid_blitz:22:1000"
    for key in (plan_key, counts_key):
        await cache.set_json(key, {"cached": True}, ttl_seconds=60)

    # What an evaluation upload does: the plan must see the new evidence, while
    # the progress counts may lag their one-minute expiry.
    await invalidate_improvement_caches("saint", include_queue_counts=False)
    assert await cache.get_json(plan_key) is None
    assert await cache.get_json(counts_key) == {"cached": True}


@pytest.mark.asyncio
async def test_invalidate_improvement_caches_clears_versioned_user_keys() -> None:
    from app.services.cache import get_shared_cache

    cache = get_shared_cache()
    saint_keys = (
        f"improvement:candidates:v{_CANDIDATE_CACHE_VERSION}:saint:both:rapid_blitz:80:18:1000",
        "improvement:coverage:v7:saint:both:rapid_blitz:18:1000",
        "improvement:trends:v8:saint:both:rapid_blitz:80:18",
        "improvement:context:saint:both:rapid_blitz",
        "coverage:v3:saint:both:rapid_blitz:22",
        "mistakes:v7:saint:both:rapid_blitz:None:2:50:18",
    )
    other_key = f"improvement:candidates:v{_CANDIDATE_CACHE_VERSION}:other:both:rapid_blitz:80:18:1000"
    for key in (*saint_keys, other_key):
        await cache.set_json(key, {"cached": True}, ttl_seconds=60)

    await invalidate_improvement_caches("saint")

    assert all([await cache.get_json(key) is None for key in saint_keys])
    assert await cache.get_json(other_key) == {"cached": True}


def test_classify_pattern_uses_concrete_board_features() -> None:
    pattern = classify_pattern(
        fen="r3k2r/ppp2ppp/2n5/3qp3/8/2N2N2/PPP2PPP/R2Q1RK1 w kq -",
        ply=21,
        user_move_uci="c3b5",
        best_move_uci="d1d5",
        opponent_reply_uci="d5d1",
        parent_eval_cp=0,
        mover_is_white=True,
        eval_drop_cp=240,
        user_move_san="Nb5",
        best_move_san="Qxd5",
    )

    assert pattern.key == "hanging_material"
    assert "capture" in pattern.cue


def test_classify_pattern_uses_clock_evidence_for_time_pressure() -> None:
    pattern = classify_pattern(
        fen="r3k2r/ppp2ppp/2n5/3qp3/8/2N2N2/PPP2PPP/R2Q1RK1 w kq -",
        ply=41,
        user_move_uci="c3b5",
        best_move_uci="d1d5",
        opponent_reply_uci="d5d1",
        parent_eval_cp=0,
        mover_is_white=True,
        eval_drop_cp=240,
        user_move_san="Nb5",
        best_move_san="Qxd5",
        clock_seconds_after=11.2,
        think_seconds=8.4,
        time_control="300+2",
    )

    assert pattern.key == "time_pressure"
    assert "11 seconds" in pattern.explanation
    assert "10%" in pattern.cue


def test_review_schedule_stays_bounded_through_long_term_recall_lapses_and_recovery() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    streak, interval, ease = 0, 0, 2.0
    intervals = []
    for _ in range(100):
        previous_interval = interval
        streak, interval, ease, due = next_review(
            now=now, correct=True, streak=streak, interval_days=interval, ease_factor=ease,
        )
        assert previous_interval <= interval <= 60
        assert 1.3 <= ease <= 2.8
        assert due == now + timedelta(days=interval)
        intervals.append(interval)
        now = due
    assert intervals[:2] == [1, 3]
    assert intervals[-1] == 60
    assert streak == 100

    for _ in range(100):
        streak, interval, ease, due = next_review(
            now=now, correct=False, streak=streak, interval_days=interval, ease_factor=ease,
        )
        assert (streak, interval) == (0, 0)
        assert 1.3 <= ease <= 2.8
        assert due == now + timedelta(minutes=10)
        now = due
    assert ease == 1.3

    for expected_streak, expected_interval in [(1, 1), (2, 3)]:
        streak, interval, ease, due = next_review(
            now=now, correct=True, streak=streak, interval_days=interval, ease_factor=ease,
        )
        assert (streak, interval) == (expected_streak, expected_interval)
        assert due == now + timedelta(days=expected_interval)
        now = due


def test_next_review_repeats_errors_soon_and_expands_correct_intervals() -> None:
    now = datetime(2026, 9, 3, tzinfo=UTC)
    streak, interval, ease, due = next_review(
        now=now,
        correct=False,
        streak=3,
        interval_days=7,
        ease_factor=2.2,
    )
    assert (streak, interval, ease) == (0, 0, 2.0)
    assert due == now + timedelta(minutes=10)

    streak, interval, ease, due = next_review(
        now=now,
        correct=True,
        streak=1,
        interval_days=1,
        ease_factor=2.0,
    )
    assert (streak, interval, ease) == (2, 3, 2.05)
    assert due == now + timedelta(days=3)


def test_move_san_repairs_missing_evaluator_notation() -> None:
    assert move_san(START, "e2e4") == "e4"
    assert move_san(START, "e2e4", "stored") == "stored"


@pytest.mark.asyncio
async def test_plan_defaults_to_rapid_and_blitz_and_persists_attempts(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                Position(id=1, fen=START, total_games=2),
                Position(id=2, fen=AFTER_NF3, total_games=2),
                Position(id=3, fen=AFTER_E4, total_games=1),
            ]
        )
        games = (
            [(game_id, "rapid", 1200) for game_id in range(1, 11)]
            + [(11, "bullet", 1200), (12, "rapid", 999), (13, "rapid", 1200)]
        )
        for game_id, time_class, rating in games:
            session.add(
                Game(
                    id=game_id,
                    chesscom_game_url=f"https://chess.com/game/{game_id}",
                    chesscom_game_id=str(game_id),
                    username="tester",
                    white_username="tester",
                    black_username="opponent",
                    user_color="white",
                    result="0-1",
                    user_result="loss",
                    time_class=time_class,
                    time_control="600",
                    white_rating=rating,
                    black_rating=1200,
                    pgn="",
                    played_at=datetime(2026, 9, game_id, tzinfo=UTC),
                    num_moves=1,
                    termination="timeout",
                )
            )
            session.add_all(
                [
                    GamePosition(game_id=game_id, position_id=1, ply=0),
                    GamePosition(
                        game_id=game_id,
                        position_id=3 if game_id == 13 else 2,
                        ply=1,
                        move_san="e4" if game_id == 13 else "Nf3",
                        move_uci="e2e4" if game_id == 13 else "g1f3",
                    ),
                ]
            )
        session.add_all(
            [
                AnalysisResult(
                    position_id=1,
                    engine="stockfish-19",
                    depth=22,
                    eval_cp=20,
                    best_move_uci="e2e4",
                    best_move_san="e4",
                    multipv_rank=1,
                ),
                AnalysisResult(
                    position_id=1,
                    engine="stockfish-19",
                    depth=22,
                    eval_cp=5,
                    best_move_uci="d2d4",
                    best_move_san="d4",
                    multipv_rank=2,
                ),
                AnalysisResult(
                    position_id=2,
                    engine="stockfish-19",
                    depth=22,
                    eval_cp=-100,
                    best_move_uci="e7e5",
                    best_move_san="e5",
                    multipv_rank=1,
                ),
                # Deliberately inconsistent adjacent eval: the player chose the
                # engine's best move, so this must never become a mistake card.
                AnalysisResult(
                    position_id=3,
                    engine="stockfish-19",
                    depth=22,
                    eval_cp=-500,
                    best_move_uci="e7e5",
                    best_move_san="e5",
                    multipv_rank=1,
                ),
            ]
        )
        await session.commit()

        plan = await build_improvement_plan(session, username="tester")
        assert plan.time_class == "rapid_blitz"
        assert len(plan.drills) == 1
        assert plan.summary.candidate_positions_is_lower_bound is False
        assert plan.drills[0].occurrences == 10
        assert plan.drills[0].time_class == "rapid"
        assert plan.drills[0].pattern_key == "opening_decision"
        # Bullet and games played below the 1000 training-era floor are out of scope.
        # The 11th in-scope decision was the engine's best move, so it counts as
        # analyzed evidence but never as a mistake.
        assert (plan.summary.total_decisions, plan.summary.analyzed_decisions) == (11, 11)
        assert plan.summary.coverage_rate == 1.0
        assert plan.summary.insights[0].key == "rapid_clock_management"
        assert plan.summary.insights[0].rate == 1.0
        assert plan.summary.prescription.focus == "Opening decision"
        assert "10 occurrences" in plan.summary.prescription.evidence

        focused_plan = await build_improvement_plan(
            session, username="tester", pattern_key="opening_decision"
        )
        assert {drill.pattern_key for drill in focused_plan.drills} == {
            "opening_decision"
        }

        from app.services.cache import get_shared_cache

        cache = get_shared_cache()
        invalidation = AsyncMock(wraps=cache.delete_prefix)
        monkeypatch.setattr(cache, "delete_prefix", invalidation)
        attempt = await record_drill_attempt(
            session,
            DrillAttemptIn(
                username="tester",
                position_id=1,
                expected_move_uci="e2e4",
                played_move_uci="g1f3",
                pattern_key="opening_decision",
                response_ms=9000,
            ),
        )
        await session.commit()
        assert attempt.correct is False
        assert attempt.attempts == 1
        assert attempt.due_at > datetime.now(UTC)
        # The expensive cached candidates contain game/evaluation facts, not
        # progress. Attempts must preserve them; scheduling is read live below.
        invalidation.assert_not_called()

        accepted_alternative = await record_drill_attempt(
            session,
            DrillAttemptIn(
                username="alternate-tester",
                position_id=1,
                expected_move_uci="e2e4",
                played_move_uci="d2d4",
                pattern_key="opening_decision",
                response_ms=5000,
            ),
        )
        await session.commit()
        assert accepted_alternative.correct is True

        # Two failed attempts are not a lapse: this answer was never learned.
        await record_drill_attempt(
            session,
            DrillAttemptIn(
                username="tester", position_id=1, expected_move_uci="e2e4",
                played_move_uci="g1f3", pattern_key="opening_decision",
            ),
        )
        await session.commit()

        scheduled_plan = await build_improvement_plan(session, username="tester")
        assert scheduled_plan.summary.due_positions == 0
        assert scheduled_plan.drills == []

        retention = scheduled_plan.summary.retention
        assert retention.tracked_positions == 1
        assert retention.retained_positions == 0
        assert retention.lapsed_positions == 0
        assert retention.retention_rate == 0.0
        # Scheduled cards stay visible in the curriculum even while they are not
        # due, so users can see what they have started and what they have learned.
        assert scheduled_plan.summary.patterns[0].positions == 1
        assert scheduled_plan.summary.patterns[0].due_positions == 0
        assert scheduled_plan.summary.patterns[0].learned_positions == 0

        for _ in range(2):
            await session.execute(update(DrillProgress).where(DrillProgress.username == "tester").values(due_at=datetime.now(UTC) - timedelta(seconds=1)))
            await record_drill_attempt(
                session,
                DrillAttemptIn(
                    username="tester",
                    position_id=1,
                    expected_move_uci="e2e4",
                    played_move_uci="e2e4",
                    pattern_key="opening_decision",
                    response_ms=5000,
                ),
            )
            await session.commit()
        learned_plan = await build_improvement_plan(session, username="tester")
        assert learned_plan.summary.patterns[0].learned_positions == 1

        # Keep historical answers, but don't count a superseded answer as a
        # second retained position in the current curriculum.
        session.add(DrillProgress(
            username="tester", position_id=1, expected_move_uci="d2d4",
            attempts=2, correct_attempts=2, streak=2,
        ))
        await session.commit()
        current_plan = await build_improvement_plan(session, username="tester")
        assert current_plan.summary.retention.tracked_positions == 1
        assert current_plan.summary.retention.retained_positions == 1

        # Bullet is out of scope, so only the rapid record is reported.
        results = scheduled_plan.summary.results_by_time_class
        assert [item.time_class for item in results] == ["rapid"]
        assert results[0].games == 11
        assert results[0].loss_rate == 1.0
        assert results[0].score_rate == 0.0


    await engine.dispose()


def test_classify_pattern_names_the_tactic_the_move_allowed() -> None:
    pattern = classify_pattern(
        fen="4k3/8/8/8/8/4n3/8/R3K3 w - -",
        ply=41,
        user_move_uci="a1a3",
        best_move_uci="e1f1",
        opponent_reply_uci="e3c2",
        reply_pv_uci="e3c2 e1d1 c2a3",
        parent_eval_cp=0,
        mover_is_white=True,
        eval_drop_cp=430,
        user_move_san="Ra3",
        best_move_san="Kf1",
    )

    assert pattern.key == "fork"
    assert pattern.label == "Fork"
    assert "king on e1" in pattern.explanation
    assert "rook on a3" in pattern.explanation
    assert [(motif.key, motif.side) for motif in pattern.motifs] == [("fork", "allowed")]


def test_classify_pattern_reports_a_missed_forced_mate_from_the_stored_line() -> None:
    pattern = classify_pattern(
        fen="6k1/5ppp/8/8/8/8/8/4R1K1 w - -",
        ply=51,
        user_move_uci="g1f1",
        best_move_uci="e1e8",
        opponent_reply_uci=None,
        best_pv_uci="e1e8",
        best_eval_mate=1,
        parent_eval_cp=1990,
        mover_is_white=True,
        eval_drop_cp=1690,
        user_move_san="Kf1",
        best_move_san="Re8#",
    )

    assert pattern.key == "missed_mate"
    assert "forces mate in 1" in pattern.explanation
    assert {motif.key for motif in pattern.motifs} == {"mate", "back_rank"}
    assert all(motif.side == "missed" for motif in pattern.motifs)


@pytest.mark.asyncio
async def test_mate_scored_positions_reach_the_drill_queue() -> None:
    """A forced mate stores no centipawn score, so the queue must accept mate scores."""

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    mate_fen = "6k1/5ppp/8/8/8/8/8/4R1K1 w - -"
    after_kf1 = "6k1/5ppp/8/8/8/8/8/4RK2 b - -"

    async with session_factory() as session:
        session.add_all(
            [
                Position(id=1, fen=mate_fen, total_games=1),
                Position(id=2, fen=after_kf1, total_games=1),
            ]
        )
        session.add(
            Game(
                id=1,
                chesscom_game_url="https://chess.com/game/1",
                chesscom_game_id="1",
                username="tester",
                white_username="tester",
                black_username="opponent",
                user_color="white",
                result="0-1",
                user_result="loss",
                time_class="blitz",
                time_control="300",
                white_rating=1200,
                black_rating=1200,
                pgn="",
                played_at=datetime(2026, 9, 1, tzinfo=UTC),
                num_moves=1,
                termination="resigned",
            )
        )
        session.add_all(
            [
                GamePosition(game_id=1, position_id=1, ply=0),
                GamePosition(
                    game_id=1, position_id=2, ply=1, move_san="Kf1", move_uci="g1f1"
                ),
            ]
        )
        session.add_all(
            [
                AnalysisResult(
                    position_id=1,
                    engine="stockfish-19",
                    depth=22,
                    eval_cp=None,
                    eval_mate=1,
                    best_move_uci="e1e8",
                    best_move_san="Re8#",
                    pv_uci="e1e8",
                    multipv_rank=1,
                ),
                AnalysisResult(
                    position_id=2,
                    engine="stockfish-19",
                    depth=22,
                    eval_cp=300,
                    best_move_uci="g8f8",
                    best_move_san="Kf8",
                    pv_uci="g8f8",
                    multipv_rank=1,
                ),
            ]
        )
        await session.commit()

        plan = await build_improvement_plan(session, username="tester")
        assert len(plan.drills) == 1
        drill = plan.drills[0]
        assert drill.pattern_key == "missed_mate"
        assert drill.best_move_san == "Re8#"
        assert {motif.key for motif in drill.motifs} == {"mate", "back_rank"}

    await engine.dispose()


@pytest.mark.asyncio
async def test_one_off_blunder_does_not_outrank_a_repeated_habit() -> None:
    """A single spectacular error must not become the weekly focus."""

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    # Three different opening positions where the same generic decision goes
    # wrong once each, plus one huge one-off blunder in a fourth game.
    habit_games = [
        (
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
            "rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq -",
            "a2a3",
            "a3",
        ),
        (
            "rnbqkbnr/ppppppp1/7p/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
            "rnbqkbnr/ppppppp1/7p/8/8/1P6/P1PPPPPP/RNBQKBNR b KQkq -",
            "b2b3",
            "b3",
        ),
        (
            "rnbqkbnr/pppppp1p/6p1/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
            "rnbqkbnr/pppppp1p/6p1/8/8/2P5/PP1PPPPP/RNBQKBNR b KQkq -",
            "c2c3",
            "c3",
        ),
    ]

    async with session_factory() as session:
        for index, (parent_fen, child_fen, move_uci, move_san) in enumerate(habit_games):
            parent_id, child_id = index * 2 + 1, index * 2 + 2
            game_id = index + 1
            session.add_all(
                [
                    Position(id=parent_id, fen=parent_fen, total_games=1),
                    Position(id=child_id, fen=child_fen, total_games=1),
                ]
            )
            session.add(
                Game(
                    id=game_id,
                    chesscom_game_url=f"https://chess.com/game/{game_id}",
                    chesscom_game_id=str(game_id),
                    username="tester",
                    white_username="tester",
                    black_username="opponent",
                    user_color="white",
                    result="0-1",
                    user_result="loss",
                    time_class="blitz",
                    time_control="300",
                    white_rating=1200,
                    black_rating=1200,
                    pgn="",
                    played_at=datetime(2026, 9, index + 1, tzinfo=UTC),
                    num_moves=1,
                    termination="resigned",
                )
            )
            session.add_all(
                [
                    GamePosition(game_id=game_id, position_id=parent_id, ply=0),
                    GamePosition(
                        game_id=game_id,
                        position_id=child_id,
                        ply=1,
                        move_san=move_san,
                        move_uci=move_uci,
                    ),
                ]
            )
            session.add_all(
                [
                    AnalysisResult(
                        position_id=parent_id,
                        engine="stockfish-19",
                        depth=22,
                        eval_cp=20,
                        best_move_uci="e2e4",
                        best_move_san="e4",
                        multipv_rank=1,
                    ),
                    AnalysisResult(
                        position_id=child_id,
                        engine="stockfish-19",
                        depth=22,
                        eval_cp=-120,
                        best_move_uci="g8f6",
                        best_move_san="Nf6",
                        multipv_rank=1,
                    ),
                ]
            )

        # The one-off: a single enormous drop in one position of one game.
        session.add_all(
            [
                Position(id=101, fen="6k1/5ppp/8/8/8/8/8/4R1K1 w - -", total_games=1),
                Position(id=102, fen="6k1/5ppp/8/8/8/8/8/4RK2 b - -", total_games=1),
            ]
        )
        session.add(
            Game(
                id=99,
                chesscom_game_url="https://chess.com/game/99",
                chesscom_game_id="99",
                username="tester",
                white_username="tester",
                black_username="opponent",
                user_color="white",
                result="0-1",
                user_result="loss",
                time_class="blitz",
                time_control="300",
                white_rating=1200,
                black_rating=1200,
                pgn="",
                played_at=datetime(2026, 9, 20, tzinfo=UTC),
                num_moves=1,
                termination="resigned",
            )
        )
        session.add_all(
            [
                GamePosition(game_id=99, position_id=101, ply=0),
                GamePosition(
                    game_id=99, position_id=102, ply=1, move_san="Kf1", move_uci="g1f1"
                ),
            ]
        )
        session.add_all(
            [
                AnalysisResult(
                    position_id=101,
                    engine="stockfish-19",
                    depth=22,
                    eval_mate=1,
                    best_move_uci="e1e8",
                    best_move_san="Re8#",
                    pv_uci="e1e8",
                    multipv_rank=1,
                ),
                AnalysisResult(
                    position_id=102,
                    engine="stockfish-19",
                    depth=22,
                    eval_cp=300,
                    best_move_uci="g8f8",
                    best_move_san="Kf8",
                    multipv_rank=1,
                ),
            ]
        )
        await session.commit()

        plan = await build_improvement_plan(session, username="tester")

        by_key = {pattern.key: pattern for pattern in plan.summary.patterns}
        assert by_key["opening_decision"].recurrence == "habit"
        assert by_key["missed_mate"].recurrence == "one_off"
        assert plan.summary.habit_positions == 3
        assert plan.summary.one_off_positions == 1
        assert plan.summary.prescription.focus == "Opening decision"
        assert "repeated habit" in plan.summary.prescription.evidence
        recurrences = [drill.recurrence for drill in plan.drills]
        assert recurrences[0] == "habit"
        assert "one_off" in recurrences  # still trainable, just never first

        # Drill accuracy is tracked per pattern, not only in one global total.
        habit_drill = next(
            (drill for drill in plan.drills if drill.pattern_key == "opening_decision"),
            None,
        )
        assert habit_drill is not None
        await record_drill_attempt(
            session,
            DrillAttemptIn(
                username="tester",
                position_id=habit_drill.position_id,
                expected_move_uci=habit_drill.best_move_uci,
                played_move_uci="h2h4",
                pattern_key="opening_decision",
            ),
        )
        await session.commit()

        reread = await build_improvement_plan(session, username="tester")
        opening_decision = next(
            (
                pattern
                for pattern in reread.summary.patterns
                if pattern.key == "opening_decision"
            ),
            None,
        )
        assert opening_decision is not None
        assert opening_decision.drill_attempts == 1
        assert opening_decision.drill_correct_rate == 0.0
        assert reread.summary.retention.tracked_positions == 1
        assert reread.summary.retention.retention_rate == 0.0

    await engine.dispose()


def test_build_follow_up_replays_two_more_plies_of_the_stored_line() -> None:
    follow_up = build_follow_up(
        "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -",
        "b8c6 f1b5 g8f6",
    )

    assert follow_up is not None
    assert follow_up.opponent_reply_san == "Bb5"
    assert follow_up.best_move_uci == "g8f6"
    assert follow_up.best_move_san == "Nf6"
    assert follow_up.fen.startswith("r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b")


def test_build_follow_up_declines_short_illegal_or_finished_lines() -> None:
    start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"
    assert build_follow_up(start, None) is None
    assert build_follow_up(start, "e2e4 e7e5") is None
    assert build_follow_up(start, "e2e4 e7e5 h1h8") is None
    # Nothing is left to calculate once the first move is already mate.
    assert build_follow_up("6k1/5ppp/8/8/8/8/8/4R1K1 w - -", "e1e8 g8h8 e8h8") is None


@pytest.mark.asyncio
async def test_calculation_drill_requires_the_second_move_of_the_line() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    parent_fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -"
    child_fen = "rnbqkbnr/ppp2ppp/8/3pp3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -"

    async with session_factory() as session:
        session.add_all(
            [
                Position(id=1, fen=parent_fen, total_games=1),
                Position(id=2, fen=child_fen, total_games=1),
            ]
        )
        session.add(
            Game(
                id=1,
                chesscom_game_url="https://chess.com/game/1",
                chesscom_game_id="1",
                username="tester",
                white_username="opponent",
                black_username="tester",
                user_color="black",
                result="1-0",
                user_result="loss",
                time_class="rapid",
                time_control="600",
                white_rating=1200,
                black_rating=1200,
                pgn="",
                played_at=datetime(2026, 9, 1, tzinfo=UTC),
                num_moves=2,
                termination="resigned",
            )
        )
        session.add_all(
            [
                GamePosition(
                    game_id=1, position_id=1, ply=1, move_san="Nf3", move_uci="g1f3"
                ),
                GamePosition(
                    game_id=1, position_id=2, ply=2, move_san="d5", move_uci="d7d5"
                ),
            ]
        )
        session.add_all(
            [
                AnalysisResult(
                    position_id=1,
                    engine="stockfish-19",
                    depth=22,
                    eval_cp=25,
                    best_move_uci="b8c6",
                    best_move_san="Nc6",
                    pv_uci="b8c6 f1b5 g8f6",
                    multipv_rank=1,
                ),
                AnalysisResult(
                    position_id=2,
                    engine="stockfish-19",
                    depth=22,
                    eval_cp=180,
                    best_move_uci="e4d5",
                    best_move_san="exd5",
                    multipv_rank=1,
                ),
            ]
        )
        await session.commit()

        plan = await build_improvement_plan(session, username="tester")
        assert len(plan.drills) == 1
        # The board shows the move being answered, not a bare position.
        assert plan.drills[0].previous_move_uci == "g1f3"
        follow_up = plan.drills[0].follow_up
        assert follow_up is not None
        assert follow_up.opponent_reply_san == "Bb5"
        assert follow_up.best_move_san == "Nf6"

        def attempt(second: str | None) -> DrillAttemptIn:
            return DrillAttemptIn(
                username="tester",
                position_id=1,
                expected_move_uci="b8c6",
                played_move_uci="b8c6",
                follow_up_move_uci=second,
                pattern_key="opening_decision",
            )

        for invalid_second in ("not-a-move", "e2e4", "a7a4"):
            with pytest.raises(ValueError, match="follow-up move is not legal"):
                await record_drill_attempt(session, attempt(invalid_second))
        assert await session.scalar(select(func.count()).select_from(DrillAttempt)) == 0
        assert await session.scalar(select(func.count()).select_from(DrillProgress)) == 0

        wrong_second = await record_drill_attempt(session, attempt("a7a6"))
        await session.commit()
        assert wrong_second.correct is False
        assert wrong_second.follow_up_correct is False

        solved = await record_drill_attempt(session, attempt("g8f6"))
        await session.commit()
        assert solved.correct is True
        assert solved.follow_up_correct is True

        repeated = await record_drill_attempt(session, attempt("g8f6"))
        await session.commit()
        assert repeated.correct is True
        assert repeated.streak == solved.streak == 1
        assert repeated.due_at == solved.due_at

        # Omitting half the calculation must not count as completing the lesson.
        first_only = await record_drill_attempt(session, attempt(None))
        await session.commit()
        assert first_only.correct is False
        assert first_only.follow_up_correct is False

    await engine.dispose()


def test_trend_status_refuses_a_verdict_the_sample_cannot_support() -> None:
    full_windows = {
        "recent_games": 30,
        "previous_games": 30,
        "minimum_decisions": 120,
        "recent_missing_decisions": 0,
        "previous_missing_decisions": 0,
    }

    # Two occurrences falling to zero is noise, not an improvement.
    assert trend_status(
        recent_occurrences=0,
        previous_occurrences=2,
        recent_rate=0.0,
        previous_rate=6.7,
        **full_windows,
    ) == ("insufficient", "low")

    # One occurrence appearing is not a worsening habit either.
    assert trend_status(
        recent_occurrences=1,
        previous_occurrences=0,
        recent_rate=3.3,
        previous_rate=0.0,
        **full_windows,
    ) == ("insufficient", "low")

    assert trend_status(
        recent_occurrences=2,
        previous_occurrences=9,
        recent_rate=6.7,
        previous_rate=30.0,
        **full_windows,
    ) == ("improving", "medium")

    assert trend_status(
        recent_occurrences=16,
        previous_occurrences=5,
        recent_rate=53.3,
        previous_rate=16.7,
        recent_games=30,
        previous_games=30,
        minimum_decisions=400,
        recent_missing_decisions=0,
        previous_missing_decisions=0,
    ) == ("worsening", "high")

    assert trend_status(
        recent_occurrences=5,
        previous_occurrences=5,
        recent_rate=16.7,
        previous_rate=16.7,
        **full_windows,
    ) == ("steady", "medium")

    # Partial windows never produce a direction, however large the swing looks.
    assert trend_status(
        recent_occurrences=9,
        previous_occurrences=0,
        recent_rate=45.0,
        previous_rate=0.0,
        recent_games=20,
        previous_games=0,
        minimum_decisions=60,
        recent_missing_decisions=0,
        previous_missing_decisions=0,
    ) == ("insufficient", "low")


def _card(
    position_id: int,
    *,
    attempts: int = 0,
    pattern: str = "calculation",
    played_at: str = "2026-01-01T00:00:00Z",
    two_move: bool = False,
    fen: str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
    source_game_id: int | None = None,
    phase: str = "opening",
) -> DrillCardOut:
    return DrillCardOut(
        position_id=position_id,
        fen=fen,
        side_to_move="white",
        user_move_san="a3",
        user_move_uci=f"a2a{position_id}",
        best_move_san="e4",
        best_move_uci="e2e4",
        eval_drop_cp=120,
        severity="mistake",
        occurrences=1,
        recurrence="habit",
        pattern_key=pattern,
        pattern_label=pattern,
        phase=phase,
        explanation="",
        cue="",
        follow_up=(
            DrillFollowUpOut(
                fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                opponent_reply_uci="e7e5",
                opponent_reply_san="e5",
                best_move_uci="g1f3",
                best_move_san="Nf3",
            )
            if two_move
            else None
        ),
        source_game_id=source_game_id if source_game_id is not None else position_id,
        source_game_url="https://example.test",
        source_played_at=played_at,
        time_class="rapid",
        attempts=attempts,
    )


def test_session_mixes_reviews_recent_errors_and_weak_patterns() -> None:
    endgame = "8/5ppp/8/8/8/8/5PPP/6K1 w - -"
    queenless = "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq -"

    review = _card(3, attempts=4, played_at="2026-02-01T00:00:00Z", source_game_id=3)
    transfer = _card(5, played_at="2026-01-01T00:00:00Z", source_game_id=5)
    recent = _card(
        2, pattern="king_safety", fen=endgame, played_at="2026-09-01T00:00:00Z", source_game_id=2
    )
    weak = _card(
        4,
        pattern="hanging_material",
        fen=queenless,
        played_at="2026-03-01T00:00:00Z",
        source_game_id=4,
    )

    session = compose_session(
        [review, transfer, recent, weak],
        weak_pattern_keys={"hanging_material"},
        limit=10,
    )

    assert [card.position_id for card in session] == [3, 5, 2, 4]
    assert [card.queue_source for card in session] == ["review", "transfer", "recent", "weak"]


def test_session_does_not_repeat_one_board_for_different_historical_errors() -> None:
    first = _card(1)
    another_error = first.model_copy(update={"user_move_uci": "d2d4"})
    session = compose_session([first, another_error, _card(2)], weak_pattern_keys=set(), limit=10)
    assert [card.position_id for card in session] == [1, 2]


def test_session_stops_at_the_time_budget_rather_than_the_card_limit() -> None:
    ranked = [
        _card(index, attempts=0, pattern="calculation", played_at="2026-01-01T00:00:00Z", two_move=True)
        for index in range(1, 21)
    ]

    session = compose_session(ranked, weak_pattern_keys=set(), limit=20, budget_seconds=180)

    # Two-move drills are budgeted at 60 seconds each.
    assert len(session) == 3


def test_transfer_drills_repeat_the_same_shape_from_a_different_game() -> None:
    """Transfer positions come from the player's own games, never from a puzzle set."""

    anchor_fen = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq -"
    twin_fen = "r1bqk2r/pppp1ppp/2n2n2/4p3/1bB1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq -"
    unrelated_fen = "8/5ppp/8/8/8/8/5PPP/6K1 w - -"

    anchor = _card(1, pattern="hanging_material", fen=anchor_fen, source_game_id=10)
    twin = _card(2, pattern="hanging_material", fen=twin_fen, source_game_id=11)
    same_game = _card(3, pattern="hanging_material", fen=twin_fen, source_game_id=10)
    other_pattern = _card(4, pattern="king_safety", fen=twin_fen, source_game_id=12)
    other_shape = _card(5, pattern="hanging_material", fen=unrelated_fen, source_game_id=13)

    assert structure_signature(anchor_fen) == structure_signature(twin_fen)
    assert structure_signature(anchor_fen) != structure_signature(unrelated_fen)

    session = compose_session(
        [anchor, twin, same_game, other_pattern, other_shape],
        weak_pattern_keys=set(),
        limit=4,
    )
    by_source = {card.queue_source: card.position_id for card in session}
    assert by_source["transfer"] == twin.position_id


def test_compare_intent_checks_the_stated_routine_against_the_detected_pattern() -> None:
    matched, feedback = compare_intent("opponent_captures", "hanging_material")
    assert matched is True
    assert "opponent's strongest reply" in feedback

    mismatched, feedback = compare_intent("opponent_captures", "missed_mate")
    assert mismatched is False
    assert "missed forced mate" in feedback
    assert "Include that check" in feedback

    # No claim, no judgement.
    assert compare_intent(None, "calculation") == (None, None)
    assert compare_intent("not-a-routine", "calculation") == (None, None)


@pytest.mark.asyncio
async def test_stated_intent_is_stored_and_compared_on_the_attempt() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add(Position(id=1, fen=START, total_games=1))
        session.add(
            AnalysisResult(
                position_id=1,
                engine="stockfish-19",
                depth=22,
                eval_cp=20,
                best_move_uci="e2e4",
                best_move_san="e4",
                multipv_rank=1,
            )
        )
        await session.commit()

        result = await record_drill_attempt(
            session,
            DrillAttemptIn(
                username="tester",
                position_id=1,
                expected_move_uci="e2e4",
                played_move_uci="g1f3",
                pattern_key="hanging_material",
                intent_key="threats_to_my_king",
            ),
        )
        await session.commit()

        assert result.correct is False
        assert result.intent_matched is False
        assert "hanging material" in result.intent_feedback

        stored = await session.scalar(select(DrillAttempt.intent_key))
        assert stored == "threats_to_my_king"

    await engine.dispose()


@pytest.mark.asyncio
async def test_coverage_counts_the_players_decisions_not_every_position() -> None:
    """A decision only counts as analyzed when both sides of the move are evaluated."""

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                Position(id=1, fen=START, total_games=1),
                Position(id=2, fen=AFTER_NF3, total_games=1),
                Position(id=3, fen="rnbqkb1r/pppppppp/5n2/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq -"),
                Position(id=4, fen="rnbqkb1r/pppppppp/5n2/8/8/5N1P/PPPPPPP1/RNBQKB1R b KQkq -"),
            ]
        )
        session.add(
            Game(
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
                black_rating=1200,
                pgn="",
                played_at=datetime(2026, 9, 1, tzinfo=UTC),
                num_moves=3,
                termination="resigned",
            )
        )
        session.add_all(
            [
                GamePosition(game_id=1, position_id=1, ply=0),
                GamePosition(game_id=1, position_id=2, ply=1, move_san="Nf3", move_uci="g1f3"),
                GamePosition(game_id=1, position_id=3, ply=2, move_san="Nf6", move_uci="g8f6"),
                GamePosition(game_id=1, position_id=4, ply=3, move_san="h3", move_uci="h2h3"),
            ]
        )
        # Only the first of the player's two decisions has evaluations on both sides.
        session.add_all(
            [
                AnalysisResult(
                    position_id=1, engine="stockfish-19", depth=22, eval_cp=20,
                    best_move_uci="e2e4", best_move_san="e4", multipv_rank=1,
                ),
                AnalysisResult(
                    position_id=2, engine="stockfish-19", depth=22, eval_cp=-100,
                    best_move_uci="e7e5", best_move_san="e5", multipv_rank=1,
                ),
                AnalysisResult(
                    position_id=3, engine="stockfish-19", depth=22, eval_cp=15,
                    best_move_uci="e2e4", best_move_san="e4", multipv_rank=1,
                ),
            ]
        )
        await session.commit()

        plan = await build_improvement_plan(session, username="tester")

        # Four positions exist, but the player made only two decisions (plies 1 and 3),
        # and only the first has a trusted evaluation on both sides.
        assert plan.summary.total_decisions == 2
        assert plan.summary.analyzed_decisions == 1
        assert plan.summary.coverage_rate == 0.5
        assert plan.summary.patterns
        assert "1 of 2 eligible decisions (50.0%)" in plan.summary.prescription.evidence
        assert "not your complete game history" in plan.summary.prescription.evidence

        # Move number alone cannot turn a full board of pieces into an endgame.
        await session.execute(update(GamePosition).where(GamePosition.ply == 0).values(ply=60))
        await session.execute(update(GamePosition).where(GamePosition.ply == 1).values(ply=61))
        await session.commit()
        await invalidate_improvement_caches("tester")
        later = await build_improvement_plan(session, username="tester")
        counts = {phase.phase: phase.analyzed_decisions for phase in later.summary.analyzed_by_phase}
        assert counts == {"opening": 0, "middlegame": 1, "endgame": 0}

    await engine.dispose()


def test_stop_advice_refuses_to_generalise_from_one_phase_of_the_game() -> None:
    def phases(opening: int, middlegame: int, endgame: int) -> list[PhaseCoverageOut]:
        total = opening + middlegame + endgame
        return [
            PhaseCoverageOut(phase=name, analyzed_decisions=count, share=count / total)
            for name, count in (
                ("opening", opening),
                ("middlegame", middlegame),
                ("endgame", endgame),
            )
        ]

    thin = _stop_advice(120, phases(100, 15, 5), total_decisions=120)
    assert "not enough personal evidence" in thin
    assert "Pause broad opening study" not in thin

    skewed = _stop_advice(10_000, phases(9_500, 400, 100), total_decisions=10_000)
    assert "95% of your analyzed decisions are in the opening" in skewed
    assert "middlegame and endgame are still severely under-measured" in skewed

    one_blind = _stop_advice(10_000, phases(8_000, 1_800, 200), total_decisions=10_000)
    assert "endgame is still severely under-measured" in one_blind

    balanced = _stop_advice(10_000, phases(4_000, 4_000, 2_000), total_decisions=10_000)
    assert balanced.startswith("Do not add unrelated study material")

    sparse = _stop_advice(4_000, phases(1_600, 1_600, 800), total_decisions=100_000)
    assert "4.0%" in sparse
    assert "provisional" in sparse
    assert "Do not add unrelated study material" not in sparse


@pytest.mark.asyncio
async def test_historical_attempt_totals_survive_an_empty_candidate_list() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            session.add(Position(id=1, fen=START))
            await session.flush()
            session.add_all([
                DrillProgress(username="learner", position_id=1, expected_move_uci="e2e4",
                              attempts=3, correct_attempts=2, streak=2),
                # An older answer remains part of history, not current mastery.
                DrillProgress(username="learner", position_id=1, expected_move_uci="d2d4",
                              attempts=2, correct_attempts=1),
                DrillProgress(username="another", position_id=1, expected_move_uci="e2e4",
                              attempts=100, correct_attempts=100),
            ])
            await session.commit()
            plan = await build_improvement_plan(session, username="LEARNER")
            assert plan.drills == []
            assert plan.summary.attempts == 5
            assert plan.summary.correct_rate == 0.6
            assert plan.summary.retention.tracked_positions == 0
            assert plan.summary.retention.retained_positions == 0
            empty = await build_improvement_plan(session, username="untrained")
            assert empty.summary.attempts == 0
            assert empty.summary.correct_rate is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_empty_plan_directs_new_user_to_import_before_analysis() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        plan = await build_improvement_plan(session, username="new_player")

    assert plan.drills == []
    assert plan.summary.total_decisions == 0
    assert plan.summary.prescription.action == (
        "Import your Rapid and Blitz games first, then start browser analysis."
    )
    await engine.dispose()
