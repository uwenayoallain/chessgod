from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.services.rating_goal import build_rating_goal, pace_per_day, suggested_goal

NOW = datetime(2026, 9, 30, 12, tzinfo=UTC)


def test_the_pace_is_a_fitted_line_and_needs_enough_games() -> None:
    assert pace_per_day([(day, 1500 + 2 * day) for day in range(30)]) == pytest.approx(2.0)
    assert pace_per_day([(day, 1500) for day in range(5)]) is None
    assert (suggested_goal(1669), suggested_goal(1700), suggested_goal(1601)) == (1800, 1800, 1800)


@pytest.mark.asyncio
async def test_a_climb_gets_a_date_and_the_goal_level_gets_a_score() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    games = []
    # Sixty days of games, one a day, climbing a point a day from 1600.
    for day in range(60):
        rating = 1600 + day
        # Every third opponent is rated around 1800, and those are all lost.
        opponent = 1800 if day % 3 == 0 else rating
        games.append(Game(
            id=day + 1, chesscom_game_url=f"u{day}", chesscom_game_id=str(day), username="tester",
            white_username="tester", black_username="b", user_color="white", result="1-0",
            user_result="loss" if opponent == 1800 else "win", time_class="rapid", time_control="600",
            white_rating=rating, black_rating=opponent, pgn="-",
            played_at=NOW - timedelta(days=59 - day), num_moves=40,
        ))
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add_all(games)
        await session.commit()
        result = await build_rating_goal(session, username="tester", time_class="rapid", goal=1800, now=NOW)
    await engine.dispose()

    assert result["current"] == 1659
    assert result["peak"] == 1659
    # The game exactly thirty days ago is not before the cut: the one a day earlier is.
    assert result["change_30d"] == 31
    assert result["pace_per_month"] == pytest.approx(30.0)
    # 141 points at a point a day.
    assert result["eta"] == (NOW + timedelta(days=141)).date().isoformat()
    assert result["vs_goal"] == {"games": 20, "score": 0.0}
    assert result["vs_level"]["score"] == 1.0
    assert len(result["points"]) == 60
