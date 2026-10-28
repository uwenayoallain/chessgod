"""The road to a rating goal: where the player is, how fast they are moving, and
how they do against the players already there.

A goal is only motivating when it is honest. The pace is a least-squares line
through the last 90 days of games, not the best month; a pace that is flat or
falling says so instead of promising a date. And the most useful number is not
the date at all but the score against opponents rated around the goal: being
rated there means scoring about half against them.
"""

from __future__ import annotations

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
RESULT_SCORE = {"win": 1.0, "draw": 0.5, "loss": 0.0}


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def suggested_goal(current: int) -> int:
    """The next round hundred at least a hundred points up: 1669 -> 1800."""
    return -(-(current + 100) // 100) * 100


def pace_per_day(points: list[tuple[float, float]]) -> float | None:
    """Least-squares slope of (day, rating), or None with too few points."""
    if len(points) < MIN_PACE_GAMES:
        return None
    n = len(points)
    mean_x = sum(x for x, _ in points) / n
    mean_y = sum(y for _, y in points) / n
    spread = sum((x - mean_x) ** 2 for x, _ in points)
    if spread == 0:
        return None
    return sum((x - mean_x) * (y - mean_y) for x, y in points) / spread


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
    slope = pace_per_day([
        ((when - pace_from).total_seconds() / 86_400, rating)
        for when, rating, _, _ in games if when >= pace_from
    ])
    per_month = round(slope * 30, 1) if slope is not None else None
    eta = None
    if goal > current and per_month is not None and per_month >= MIN_PACE_PER_MONTH:
        days = (goal - current) / slope  # type: ignore[operator]
        if days <= MAX_ETA_DAYS:
            eta = (now + timedelta(days=days)).date().isoformat()

    def score(items: list) -> float | None:
        return round(sum(RESULT_SCORE.get(result, 0.0) for *_, result in items) / len(items), 3) if items else None

    at_goal = [game for game in games if game[2] is not None and abs(game[2] - goal) <= GOAL_BAND]
    at_level = [game for game in games if game[2] is not None and abs(game[2] - current) <= GOAL_BAND]
    return {
        "time_class": time_class,
        "goal": goal,
        "current": current,
        "change_30d": current - start_month,
        "peak": peak,
        "peak_at": peak_when.date().isoformat(),
        "pace_per_month": per_month,
        "pace_games": sum(1 for when, *_ in games if when >= pace_from),
        "eta": eta,
        "vs_goal": {"games": len(at_goal), "score": score(at_goal) if len(at_goal) >= MIN_GOAL_GAMES else None},
        "vs_level": {"games": len(at_level), "score": score(at_level) if len(at_level) >= MIN_GOAL_GAMES else None},
        "band": GOAL_BAND,
        "points": [{"date": day, "rating": rating} for day, rating in daily.items()],
    }
