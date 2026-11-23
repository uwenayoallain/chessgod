from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.services.improvement import _pattern_trends, trend_status


@pytest.mark.parametrize(
    ("recent", "previous", "missing_recent", "missing_previous", "status"),
    [
        (0, 6, 6, 0, "insufficient"),  # missing new errors could erase the improvement
        (6, 0, 0, 6, "insufficient"),  # missing old errors could erase the worsening
        (6, 6, 2, 0, "insufficient"),  # equal observed counts do not establish stability
        (0, 6, 1, 0, "improving"),     # even the worst missing result preserves direction
        (6, 0, 0, 1, "worsening"),
    ],
)
def test_trend_direction_accounts_for_unevaluated_decisions(
    recent: int, previous: int, missing_recent: int, missing_previous: int, status: str,
) -> None:
    assert trend_status(
        recent_occurrences=recent,
        previous_occurrences=previous,
        recent_rate=recent * 100 / 30,
        previous_rate=previous * 100 / 30,
        recent_games=30,
        previous_games=30,
        minimum_decisions=200,
        recent_missing_decisions=missing_recent,
        previous_missing_decisions=missing_previous,
    ) == (status, "low")


@pytest.mark.asyncio
@pytest.mark.parametrize("complete", [False, True])
async def test_trends_count_best_moves_and_distinguish_missing_evidence(complete: bool) -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            session.add_all([
                Position(id=1, fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"),
                Position(id=2, fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"),
                Position(id=3, fen="rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq -"),
                Position(id=4, fen="rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -"),
            ])
            for position_id, score, move, san in [
                (1, 20, "e2e4", "e4"),
                (2, -500, "e7e5", "e5"),  # deliberately noisy best-move child score
                (3, -100, "e7e5", "e5"),
                *([(4, 20, "e7e5", "e5")] if complete else []),
            ]:
                session.add(AnalysisResult(
                    position_id=position_id, depth=22, eval_cp=score,
                    best_move_uci=move, best_move_san=san, multipv_rank=1,
                ))
            for index in range(60):
                # First 30 games: six observed errors. Latest 30: six decisions
                # without evals (or six sound alternatives after analysis).
                child_id, move, san = (
                    (3, "g1f3", "Nf3") if index < 6 else
                    (4, "d2d4", "d4") if 30 <= index < 36 else
                    (2, "e2e4", "e4")
                )
                session.add(Game(
                    id=index + 1, chesscom_game_url=f"https://chess.com/game/{index}",
                    chesscom_game_id=str(index), username="tester",
                    white_username="tester", black_username="opponent", user_color="white",
                    result="1/2-1/2", user_result="draw", time_class="rapid", time_control="600",
                    white_rating=1200, black_rating=1200, pgn="", num_moves=1,
                    played_at=datetime(2026, 1, 1, tzinfo=UTC) + timedelta(days=index),
                ))
                session.add_all([
                    GamePosition(game_id=index + 1, position_id=1, ply=0),
                    GamePosition(game_id=index + 1, position_id=child_id, ply=1, move_uci=move, move_san=san),
                ])
            await session.commit()
            trends = await _pattern_trends(
                session, username="tester", color="both", time_class="rapid_blitz",
                threshold_cp=80, min_depth=18, min_user_rating=1000,
            )
            assert len(trends) == 1
            trend = trends[0]
            assert trend.key == "opening_decision"
            assert (trend.recent_occurrences, trend.previous_occurrences) == (0, 6)
            assert (trend.recent_total_decisions, trend.previous_total_decisions) == (30, 30)
            assert trend.recent_analyzed_decisions == (30 if complete else 24)
            assert trend.previous_analyzed_decisions == 30
            assert trend.status == ("improving" if complete else "insufficient")
    finally:
        await engine.dispose()
