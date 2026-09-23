from __future__ import annotations

from datetime import UTC, datetime
from dataclasses import replace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.services.cache import get_shared_cache
from app.services.improvement import pattern_priority_key, pattern_priority_score
from app.services.ranking_eval import RankingEvaluation, evaluate_ranking, evaluate_ranking_rolling


# Two distinguishable failure modes, so the holdout can agree or disagree with the
# ranking built from the earlier games.
_OPENING_PARENT = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"
_OPENING_CHILD = "rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq -"
_HANGING_PARENT = "r3k2r/ppp2ppp/2n5/3qp3/8/2N2N2/PPP2PPP/R2Q1RK1 w kq -"
_HANGING_CHILD = "r3k2r/ppp2ppp/2n5/1N1qp3/8/5N2/PPP2PPP/R2Q1RK1 b kq -"


@pytest.mark.asyncio
@pytest.mark.parametrize("complete,expected_positions,expected_loss", [(False, 2, 200), (True, 3, 250)])
async def test_holdout_reads_every_page_but_training_matches_queue_limit(
    monkeypatch, complete, expected_positions, expected_loss,
):
    import app.services.ranking_eval as ranking

    def item(pid, loss):
        return {"position_id": pid, "analysis": {"key": "calculation"},
                "eval_drop_cp": loss, "occurrences": 1}

    loader = AsyncMock(side_effect=[[item(1, 100), item(2, 100)], [item(3, 50)]])
    monkeypatch.setattr(ranking, "_load_candidates", loader)
    monkeypatch.setattr(ranking, "_CANDIDATE_SCAN_LIMIT", 2)
    evidence, positions = await ranking._window_losses(
        AsyncMock(), username="tester", color="both", time_class="rapid_blitz",
        threshold_cp=80, min_depth=18, complete=complete,
    )
    assert positions == expected_positions
    assert evidence["calculation"]["loss"] == expected_loss
    assert [call.kwargs["scan_offset"] for call in loader.await_args_list] == ([0, 2] if complete else [0])
    assert all(call.kwargs["cache_results"] is False for call in loader.await_args_list)


@pytest.mark.asyncio
async def test_rolling_evaluation_does_not_count_one_cutoff_as_multiple_origins(monkeypatch) -> None:
    import app.services.ranking_eval as ranking

    split = RankingEvaluation(
        username="tester", cutoff=datetime(2026, 1, 1, tzinfo=UTC),
        train_games=200, holdout_games=100, train_positions=200, holdout_positions=200,
        lift=0.3, verdict="better than chance",
    )
    evaluate = AsyncMock(return_value=split)
    monkeypatch.setattr(ranking, "evaluate_ranking", evaluate)
    result = await evaluate_ranking_rolling(AsyncMock(), username="tester", fractions=(0.25, 0.26))
    assert len(result.splits) == 2
    assert result.usable_splits == 1
    assert result.verdict == "insufficient"

    second = replace(split, cutoff=datetime(2026, 2, 1, tzinfo=UTC), lift=-0.1)
    evaluate.side_effect = [split, split, second]
    result = await evaluate_ranking_rolling(AsyncMock(), username="tester", fractions=(0.25, 0.26, 0.3))
    assert result.usable_splits == 2
    assert result.mean_lift == 0.1
    assert result.worst_lift == -0.1
    assert result.verdict == "no better than chance"


@pytest.mark.asyncio
@pytest.mark.parametrize("settings", [{"top_k": 0}, {"top_k": -1}, {"holdout_fraction": 0},
    {"holdout_fraction": 1}, {"holdout_fraction": float("nan")},
    {"min_train_positions": 0}, {"min_holdout_positions": 0}])
async def test_evaluation_rejects_invalid_settings_before_querying(settings) -> None:
    session = AsyncMock()
    with pytest.raises(ValueError):
        await evaluate_ranking(session, username="tester", **settings)
    session.scalar.assert_not_awaited()


async def _seed(session, *, games: list[tuple[int, str, datetime]]) -> None:
    session.add_all(
        [
            Position(id=1, fen=_OPENING_PARENT, total_games=1),
            Position(id=2, fen=_OPENING_CHILD, total_games=1),
            Position(id=3, fen=_HANGING_PARENT, total_games=1),
            Position(id=4, fen=_HANGING_CHILD, total_games=1),
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
                position_id=2,
                engine="stockfish-19",
                depth=22,
                eval_cp=-120,
                best_move_uci="g8f6",
                best_move_san="Nf6",
                multipv_rank=1,
            ),
            AnalysisResult(
                position_id=3,
                engine="stockfish-19",
                depth=22,
                eval_cp=0,
                best_move_uci="d1d5",
                best_move_san="Qxd5",
                multipv_rank=1,
            ),
            AnalysisResult(
                position_id=4,
                engine="stockfish-19",
                depth=22,
                eval_cp=-300,
                best_move_uci="d5d1",
                best_move_san="Qxd1",
                multipv_rank=1,
            ),
        ]
    )
    for game_id, kind, played_at in games:
        parent_id, child_id, move_uci, move_san = (
            (1, 2, "a2a3", "a3") if kind == "opening" else (3, 4, "c3b5", "Nb5")
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
                time_class="rapid",
                time_control="600",
                white_rating=1200,
                black_rating=1200,
                pgn="",
                played_at=played_at,
                num_moves=1,
                termination="resigned",
            )
        )
        ply = 0 if parent_id == 1 else 20
        session.add_all(
            [
                GamePosition(game_id=game_id, position_id=parent_id, ply=ply),
                GamePosition(
                    game_id=game_id,
                    position_id=child_id,
                    ply=ply + 1,
                    move_san=move_san,
                    move_uci=move_uci,
                ),
            ]
        )
    await session.commit()


async def _evaluate(username: str, games: list[tuple[int, str, datetime]], top_k: int = 1):
    await get_shared_cache().delete_prefix("improvement:candidates:")
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with session_factory() as session:
        await _seed(session, games=games)
        result = await evaluate_ranking(
            session,
            username=username,
            time_class="rapid",
            top_k=top_k,
            # The synthetic corpora here are deliberately tiny; the size guard
            # itself is covered by its own test.
            min_holdout_positions=1,
            min_train_positions=1,
        )
    await engine.dispose()
    return result


def _games(kinds: list[str]) -> list[tuple[int, str, datetime]]:
    return [
        (index, kind, datetime(2026, 1, index, tzinfo=UTC))
        for index, kind in enumerate(kinds, start=1)
    ]


@pytest.mark.asyncio
async def test_ranking_that_transfers_beats_a_blind_pick_on_unseen_games() -> None:
    # Nine older games are mostly hanging material, and so are the three newest.
    result = await _evaluate(
        "tester",
        _games(["hanging"] * 7 + ["opening"] * 2 + ["hanging", "hanging", "opening"]),
    )

    assert result.cutoff is not None
    assert (result.train_games, result.holdout_games) == (9, 3)
    assert result.top_patterns == ["hanging_material"]
    assert result.holdout_loss_cp == 300 * 2 + 140
    assert result.covered_loss_cp == 300 * 2
    assert result.baseline_coverage == 0.5
    assert result.lift > 0.05
    assert result.verdict == "better than chance"


@pytest.mark.asyncio
async def test_a_ranking_that_does_not_transfer_is_reported_as_such() -> None:
    # The older games favor hanging material; the newest repeat opening errors.
    result = await _evaluate(
        "tester",
        _games(["hanging"] * 8 + ["opening"] * 4),
    )

    assert result.top_patterns == ["hanging_material"]
    assert result.covered_loss_cp == 0
    assert result.coverage == 0.0
    assert result.verdict == "worse than chance"


@pytest.mark.asyncio
@pytest.mark.parametrize("top_k", [1, 3])
async def test_blind_baseline_cannot_pick_patterns_absent_from_training(top_k: int) -> None:
    result = await _evaluate("tester", _games(["opening"] * 9 + ["hanging"] * 3), top_k=top_k)
    assert result.top_patterns == ["opening_decision"]
    assert result.baseline_coverage == 0.0
    assert result.lift == 0.0
    assert result.verdict == "no better than chance"


@pytest.mark.asyncio
@pytest.mark.parametrize("first_tied_id", [1, 9])
async def test_split_counts_include_all_games_tied_at_the_cutoff(first_tied_id: int) -> None:
    games = _games(["opening"] * 8 + ["hanging"] * 4)
    tied_date = games[8][2]
    games = [(game_id, kind, tied_date if game_id >= first_tied_id else date) for game_id, kind, date in games]
    result = await _evaluate("tester", games)
    assert (result.train_games, result.holdout_games) == (first_tied_id - 1, 13 - first_tied_id)
    assert result.holdout_loss_cp == 4 * 300 + (8 * 140 if first_tied_id == 1 else 0)
    if first_tied_id == 1:
        assert result.verdict == "insufficient"
        assert result.top_patterns == []


def test_pattern_priority_balances_cost_with_independent_support() -> None:
    severe_repeated_pattern = pattern_priority_score(
        total_loss_cp=2_400,
        occurrences=8,
        positions=8,
    )
    frequent_low_cost_bucket = pattern_priority_score(
        total_loss_cp=8_000,
        occurrences=100,
        positions=80,
    )
    one_spectacular_blunder = pattern_priority_score(
        total_loss_cp=1_000,
        occurrences=1,
        positions=1,
    )

    assert severe_repeated_pattern > frequent_low_cost_bucket
    assert severe_repeated_pattern < one_spectacular_blunder
    assert pattern_priority_key(
        total_loss_cp=2_400, occurrences=8, positions=8
    ) > pattern_priority_key(total_loss_cp=1_000, occurrences=1, positions=1)
    assert pattern_priority_score(total_loss_cp=0, occurrences=0, positions=0) == 0


@pytest.mark.asyncio
async def test_evaluation_reports_insufficient_without_a_usable_split() -> None:
    result = await _evaluate("tester", _games(["opening"]))

    assert result.cutoff is None
    assert result.holdout_games == 0
    assert result.verdict == "insufficient"
    assert result.top_patterns == []


@pytest.mark.asyncio
async def test_a_holdout_too_small_to_mean_anything_gets_no_verdict() -> None:
    """Small splits swing by tens of points, so they must not produce a verdict."""

    await get_shared_cache().delete_prefix("improvement:candidates:")
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    games = _games(["hanging"] * 9 + ["hanging", "hanging", "opening"])
    async with session_factory() as session:
        await _seed(session, games=games)
        result = await evaluate_ranking(session, username="tester", time_class="rapid")
        rolling = await evaluate_ranking_rolling(session, username="tester", time_class="rapid")

    assert result.verdict == "insufficient"
    assert rolling.verdict == "insufficient"
    assert rolling.usable_splits == 0

    await engine.dispose()
