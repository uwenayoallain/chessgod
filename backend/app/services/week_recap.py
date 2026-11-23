"""A week of the player's real games, as a scoresheet.

Every game of the week in the order it was played, with what the training
aims at marked beside it: whether the game stayed in the repertoire until it
ran out, and whether the clock was used the way the challenge asks. Above it,
the week in one line: games, score, rating change, the best win, and the
training done alongside. The unit is the player's own week (Monday to Sunday
in their zone), the same one the challenges and the rival use.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.models.training import TrainingEvent
from app.services import training, training_games
from app.services.challenges import _last_clocks, used_clock, week_start

def notation(color: str, result: str) -> str:
    """The game's result as a scoresheet writes it: always from White's side."""
    if result == "draw":
        return "½–½"
    white_won = (color == "white") == (result == "win")
    return "1–0" if white_won else "0–1"
RESULT_POINTS = {"win": 1.0, "draw": 0.5, "loss": 0.0}


async def build_week_recap(
    session: AsyncSession, username: str, repertoires: list[dict], *,
    tz: str | None = None, weeks_back: int = 1, now: datetime | None = None,
) -> dict:
    now = now or datetime.now(UTC)
    zone = training._zone(tz)
    monday = week_start(now.astimezone(zone).date()) - timedelta(days=7 * weeks_back)
    start = datetime.combine(monday, datetime.min.time(), tzinfo=zone).astimezone(UTC)
    end = start + timedelta(days=7)
    rows = (
        await session.execute(
            select(Game.id, Game.chesscom_game_url, Game.played_at, Game.user_color, Game.time_class,
                   Game.time_control, Game.num_moves, Game.user_result, Game.opening_name,
                   Game.white_username, Game.black_username, Game.white_rating, Game.black_rating)
            .where(
                Game.username == username,
                Game.time_class.in_(("rapid", "blitz")),
                Game.played_at >= start - timedelta(days=1),
                Game.played_at < end + timedelta(days=1),
            )
            .order_by(Game.played_at)
        )
    ).all()
    games = [game for game in rows if start <= training._aware(game.played_at) < end]

    expected = training_games.expected_moves(repertoires)
    plies = await training_games.opening_plies(session, [game.id for game in games])
    clocks = await _last_clocks(session, [game for game in games if game.time_class == "rapid"])

    lines = []
    for game in games:
        white = game.user_color == "white"
        rating = game.white_rating if white else game.black_rating
        met, departure = training_games.first_departure(plies.get(game.id, {}), expected, game.user_color)
        lines.append({
            "game_id": game.id,
            "url": game.chesscom_game_url,
            "played_at": training._aware(game.played_at).isoformat(),
            "color": game.user_color,
            "time_class": game.time_class,
            "result": game.user_result,
            "notation": notation(game.user_color, game.user_result),
            "opponent": game.black_username if white else game.white_username,
            "opponent_rating": game.black_rating if white else game.white_rating,
            "rating": rating,
            "opening": game.opening_name,
            # None when the repertoire never came up (an opening it does not cover).
            "in_book": (departure is None) if met else None,
            "used_clock": used_clock(game.time_control, game.num_moves or 0, clocks.get(game.id))
            if game.time_class == "rapid" else None,
        })

    ratings: dict[str, dict] = {}
    for line in lines:
        if line["rating"] is None:
            continue
        entry = ratings.setdefault(line["time_class"], {"from": line["rating"], "to": line["rating"]})
        entry["to"] = line["rating"]
    wins = [line for line in lines if line["result"] == "win" and line["opponent_rating"]]
    best = max(wins, key=lambda line: line["opponent_rating"]) if wins else None
    xp = (
        await session.execute(
            select(func.coalesce(func.sum(TrainingEvent.xp), 0)).where(
                TrainingEvent.username == username,
                TrainingEvent.created_at >= start,
                TrainingEvent.created_at < end,
            )
        )
    ).scalar_one()
    counts = {result: sum(1 for line in lines if line["result"] == result) for result in ("win", "draw", "loss")}
    return {
        "week": monday.isoformat(),
        "ends": (monday + timedelta(days=6)).isoformat(),
        "games": lines,
        "played": len(lines),
        "wins": counts["win"],
        "draws": counts["draw"],
        "losses": counts["loss"],
        "score": round(sum(RESULT_POINTS.get(line["result"], 0) for line in lines) / len(lines), 3)
        if lines else None,
        "ratings": ratings,
        "best_win": best,
        "in_book": sum(1 for line in lines if line["in_book"]),
        "book_games": sum(1 for line in lines if line["in_book"] is not None),
        "clock_used": sum(1 for line in lines if line["used_clock"]),
        "xp": int(xp),
    }
