"""The road to a rating goal: where the player is, how fast they are moving, and
how they do against the players already there.

A goal is only motivating when it is honest. The pace is a least-squares line
through the last 90 days of games, not the best month; a pace that is flat or
falling says so instead of promising a date. And the most useful number is not
the date at all but the score against opponents rated around the goal: being
rated there means scoring about half against them.

Three additions keep recent form from being buried:

* ``pace_per_month`` is recency-weighted: each game counts ``0.5 ** (age / 21)``
  so a slump two months ago weighs a fraction of this week. It is still a fitted
  line over the same 90 days and still needs ``MIN_PACE_GAMES`` games and
  ``MIN_PACE_PER_MONTH`` before a date is given. ``long_term_pace_per_month`` is
  the plain, unweighted line, kept so the two can be compared.
* ``form`` is the last up-to-20 games of the last 30 days: record, score, the
  rating change across them (measured from the game *before* the window, so a
  climb out of a recent trough shows even when the rating 30 days ago happens to
  equal today's) and the performance rating, ``avg_opp - 400 * log10(1/p - 1)``
  with the score clamped to ``[1/(n+1), n/(n+1)]`` so a clean sweep is finite.
* ``vs_higher`` is the score against opponents 50 to 250 points above the player.
  A 1,700 player aiming at 2,000 is never paired with ~2,000 players, so the
  goal band is empty; the higher-rated band is the benchmark that exists.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game

HISTORY_DAYS = 180
PACE_DAYS = 90
MIN_PACE_GAMES = 20
# Monthly pace below this is noise, not a climb.
MIN_PACE_PER_MONTH = 5.0
MAX_ETA_DAYS = 3 * 365
GOAL_BAND = 75
GOAL_LOOKBACK_DAYS = 365
MIN_GOAL_GAMES = 10
# A game's weight in the pace halves every this many days.
PACE_HALF_LIFE_DAYS = 21.0
FORM_DAYS = 30
FORM_MAX_GAMES = 20
MIN_FORM_GAMES = 5
HIGHER_MIN_GAP = 50
HIGHER_MAX_GAP = 250
RESULT_SCORE = {"win": 1.0, "draw": 0.5, "loss": 0.0}


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def suggested_goal(current: int) -> int:
    """The next round hundred at least a hundred points up: 1669 -> 1800."""
    return -(-(current + 100) // 100) * 100


def pace_per_day(
    points: list[tuple[float, float]], *, half_life: float | None = None,
) -> float | None:
    """Least-squares slope of (day, rating), or None with too few points.

    With ``half_life`` the fit is weighted by ``0.5 ** (age / half_life)``, age
    being the distance in days from the newest point.
    """
    if len(points) < MIN_PACE_GAMES:
        return None
    newest = max(x for x, _ in points)
    if half_life:
        weights = [0.5 ** ((newest - x) / half_life) for x, _ in points]
    else:
        weights = [1.0] * len(points)
    total = sum(weights)
    mean_x = sum(w * x for w, (x, _) in zip(weights, points)) / total
    mean_y = sum(w * y for w, (_, y) in zip(weights, points)) / total
    spread = sum(w * (x - mean_x) ** 2 for w, (x, _) in zip(weights, points))
    if spread == 0:
        return None
    return sum(w * (x - mean_x) * (y - mean_y) for w, (x, y) in zip(weights, points)) / spread


def performance_rating(average_opponent: float, score: float, games: int) -> int:
    """Logistic performance rating: 50% is the opponents' average, 75% is +191.

    The score is clamped to [1/(n+1), n/(n+1)] so a perfect or empty record is a
    finite number rather than infinity.
    """
    p = min(max(score, 1 / (games + 1)), games / (games + 1))
    return round(average_opponent - 400 * math.log10(1 / p - 1))


def _form(games: list, now: datetime, current: int) -> dict | None:
    """The last up-to-20 games of the last 30 days, or None with fewer than 5."""
    window_from = now - timedelta(days=FORM_DAYS)
    start = len(games) - sum(1 for game in games if game[0] >= window_from)
    start = max(start, len(games) - FORM_MAX_GAMES)
    recent = games[start:]
    if len(recent) < MIN_FORM_GAMES:
        return None
    # Ratings are the player's rating after each game, so the rating before the
    # window is the game just ahead of it (the first game's own, if there is none).
    before = games[start - 1][1] if start > 0 else recent[0][1]
    wins = sum(1 for *_, result in recent if result == "win")
    draws = sum(1 for *_, result in recent if result == "draw")
    losses = len(recent) - wins - draws
    score = (wins + 0.5 * draws) / len(recent)
    opponents = [game[2] for game in recent if game[2] is not None]
    performance = (
        performance_rating(sum(opponents) / len(opponents), score, len(opponents))
        if opponents else None
    )
    return {
        "games": len(recent),
        "wins": wins,
        "draws": draws,
        "losses": losses,
        "score": round(score, 3),
        "rating_change": current - before,
        "performance": performance,
        "days": (recent[-1][0].date() - recent[0][0].date()).days + 1,
    }


async def build_rating_goal(
    session: AsyncSession, *, username: str, time_class: str, goal: int | None,
    now: datetime | None = None,
) -> dict:
    now = now or datetime.now(UTC)
    since = now - timedelta(days=GOAL_LOOKBACK_DAYS)
    rows = (
        await session.execute(
            select(Game.played_at, Game.user_color, Game.white_rating, Game.black_rating, Game.user_result)
            .where(Game.username == username, Game.time_class == time_class, Game.played_at >= since)
            .order_by(Game.played_at)
        )
    ).all()
    games = []
    for played_at, color, white, black, result in rows:
        mine, theirs = (white, black) if color == "white" else (black, white)
        if mine is None:
            continue
        games.append((_aware(played_at), int(mine), theirs, result))
    if not games:
        return {"time_class": time_class, "goal": goal, "current": None, "points": []}

    current = games[-1][1]
    if goal is None:
        goal = suggested_goal(current)
    history_from = now - timedelta(days=HISTORY_DAYS)
    daily: dict[str, int] = {}
    for when, rating, _, _ in games:
        if when >= history_from:
            daily[when.date().isoformat()] = rating
    peak_when, peak = max(((when, rating) for when, rating, _, _ in games), key=lambda item: item[1])

    month_ago = now - timedelta(days=30)
    before_month = [rating for when, rating, _, _ in games if when < month_ago]
    start_month = before_month[-1] if before_month else games[0][1]

    pace_from = now - timedelta(days=PACE_DAYS)
    pace_points = [
        ((when - pace_from).total_seconds() / 86_400, rating)
        for when, rating, _, _ in games if when >= pace_from
    ]
    slope = pace_per_day(pace_points, half_life=PACE_HALF_LIFE_DAYS)
    long_slope = pace_per_day(pace_points)
    per_month = round(slope * 30, 1) if slope is not None else None
    long_per_month = round(long_slope * 30, 1) if long_slope is not None else None
    eta = None
    if goal > current and per_month is not None and per_month >= MIN_PACE_PER_MONTH:
        days = (goal - current) / slope  # type: ignore[operator]
        if days <= MAX_ETA_DAYS:
            eta = (now + timedelta(days=days)).date().isoformat()

    def score(items: list) -> float | None:
        return round(sum(RESULT_SCORE.get(result, 0.0) for *_, result in items) / len(items), 3) if items else None

    at_goal = [game for game in games if game[2] is not None and abs(game[2] - goal) <= GOAL_BAND]
    at_level = [game for game in games if game[2] is not None and abs(game[2] - current) <= GOAL_BAND]
    at_higher = [
        game for game in games
        if game[2] is not None and current + HIGHER_MIN_GAP <= game[2] <= current + HIGHER_MAX_GAP
    ]
    return {
        "time_class": time_class,
        "goal": goal,
        "current": current,
        "change_30d": current - start_month,
        "peak": peak,
        "peak_at": peak_when.date().isoformat(),
        "pace_per_month": per_month,
        "long_term_pace_per_month": long_per_month,
        "pace_games": sum(1 for when, *_ in games if when >= pace_from),
        "eta": eta,
        "vs_goal": {"games": len(at_goal), "score": score(at_goal) if len(at_goal) >= MIN_GOAL_GAMES else None},
        "vs_level": {"games": len(at_level), "score": score(at_level) if len(at_level) >= MIN_GOAL_GAMES else None},
        "vs_higher": {
            "games": len(at_higher),
            "score": score(at_higher) if len(at_higher) >= MIN_GOAL_GAMES else None,
        },
        "form": _form(games, now, current),
        "band": GOAL_BAND,
        "points": [{"date": day, "rating": rating} for day, rating in daily.items()],
    }
