from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.services.rating_goal import (
    build_rating_goal,
    pace_per_day,
    performance_rating,
    suggested_goal,
)

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


def test_recent_games_weigh_more_in_the_pace() -> None:
    # Flat for 60 days, then a climb in the last 30: the plain line dilutes it.
    points = [(day, 1600.0) for day in range(60)] + [(60 + day, 1600.0 + 2 * day) for day in range(30)]
    plain = pace_per_day(points)
    weighted = pace_per_day(points, half_life=21.0)
    assert plain is not None and weighted is not None
    assert weighted > plain * 1.5
    # A perfect line is the same line however it is weighted.
    line = [(day, 1500 + 2 * day) for day in range(30)]
    assert pace_per_day(line, half_life=21.0) == pytest.approx(2.0)


def test_performance_rating_is_logistic_and_finite_at_the_edges() -> None:
    assert performance_rating(1700, 0.5, 20) == 1700
    assert performance_rating(1700, 0.75, 20) == 1700 + 191
    assert performance_rating(1700, 0.6, 20) == 1700 + 70
    assert performance_rating(1700, 1.0, 10) == 1700 + 400  # p = 10/11
    assert performance_rating(1700, 0.0, 10) < 1700


async def _build(games: list[Game], **kwargs) -> dict:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add_all(games)
        await session.commit()
        result = await build_rating_goal(session, username="tester", time_class="rapid", now=NOW, **kwargs)
    await engine.dispose()
    return result


def _game(index: int, days_ago: float, rating: int, opponent: int, outcome: str) -> Game:
    return Game(
        id=index + 1, chesscom_game_url=f"u{index}", chesscom_game_id=str(index), username="tester",
        white_username="tester", black_username="b", user_color="white", result="1-0",
        user_result=outcome, time_class="rapid", time_control="600",
        white_rating=rating, black_rating=opponent, pgn="-",
        played_at=NOW - timedelta(days=days_ago), num_moves=40,
    )


@pytest.mark.asyncio
async def test_form_shows_a_recent_climb_that_the_thirty_day_change_hides() -> None:
    games = []
    # Eighty to fifty-one days ago: sitting at 1687.
    for index in range(30):
        games.append(_game(index, 80 - index, 1687, 1687, "win" if index % 2 else "loss"))
    # A dip to 1646 across the next month.
    for index in range(10):
        games.append(_game(30 + index, 29 - index * 2, 1646, 1650, "loss"))
    # The last ten days: twenty games, 15 won, climbing back to 1690.
    for index in range(20):
        games.append(_game(
            40 + index, 9.5 - index * 0.45, 1650 + 2 * (index + 1), 1700, "win" if index % 4 else "loss",
        ))
    result = await _build(games, goal=2000)

    assert result["current"] == 1690
    # Thirty days ago the rating was 1687, so the month looks flat...
    assert result["change_30d"] == 3
    # ...while the last twenty games, measured from the game before them, show the climb.
    form = result["form"]
    assert form["games"] == 20
    assert (form["wins"], form["draws"], form["losses"]) == (15, 0, 5)
    assert form["rating_change"] == 1690 - 1646
    assert form["score"] == 0.75
    assert form["performance"] == 1700 + 191
    assert result["vs_goal"]["score"] is None
    assert result["long_term_pace_per_month"] is not None


@pytest.mark.asyncio
async def test_form_needs_five_games_and_is_measured_from_the_game_before_the_window() -> None:
    few = await _build([_game(i, 3 - i * 0.5, 1600 + i, 1600, "win") for i in range(4)], goal=1800)
    assert few["form"] is None

    games = [_game(0, 60, 1500, 1500, "win")]
    games += [_game(i, 10 - i, 1600 + 10 * i, 1700, "win" if i < 4 else "loss") for i in range(1, 7)]
    result = await _build(games, goal=1800)
    form = result["form"]
    # The window starts after the 60-day-old game, whose rating is the "before".
    assert form["games"] == 6
    assert form["rating_change"] == 1660 - 1500
    assert form["score"] == 0.5
    assert form["performance"] == 1700


@pytest.mark.asyncio
async def test_vs_higher_scores_the_players_rated_fifty_to_two_fifty_above() -> None:
    def first() -> list[Game]:
        # 1700 player; opponents at 1800 (in the band) and 1720 (too close).
        return [
            _game(i, 40 - i, 1700, 1800 if i % 2 == 0 else 1720, "win" if i % 4 == 0 else "loss")
            for i in range(12)
        ]

    result = await _build(first(), goal=2000)
    assert result["vs_higher"] == {"games": 6, "score": None}
    more = [_game(20 + i, 20 - i, 1700, 1800, "win" if i < 3 else "loss") for i in range(6)]
    result = await _build(first() + more, goal=2000)
    assert result["vs_higher"]["games"] == 12
    # Games 0, 4 and 8 of the first set were won, and 3 of the added six.
    assert result["vs_higher"]["score"] == pytest.approx(6 / 12, abs=1e-3)
