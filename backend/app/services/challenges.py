"""Weekly challenges scored from the player's real games, not from the app.

Everything else in the training layer pays for work done here. That is only
worth anything if it reaches the board, so these pay for what the imported
games show: rapid games where the player used their clock (their big
mistakes were played with most of it left, see `services/clock.py`), and
games that stayed in the repertoire until it ran out. A week runs Monday to
Sunday in the player's time zone; a finished challenge pays once a week,
whenever the games that finish it are imported.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.training import TrainingEvent
from app.services import training, training_games
from app.services.clock import parse_control

# A game has to last this long before using the clock is a fair ask.
MIN_CLOCK_PLIES = 60
# Ending inside this share of the starting clock counts as using it: the time
# spent, without the scramble. On the first player's 10-minute games, those
# that reached move 30 scored 51% ending with 2-5 minutes left, 46% with more
# and 42% with less — so the target rewards the middle, not the least left.
USED_CLOCK_SHARE = (0.1, 0.3)


@dataclass(frozen=True)
class Challenge:
    key: str
    title: str
    description: str
    target: int


USE_CLOCK = Challenge(
    "use_clock", "Use your clock in 3 rapid games",
    "Reach move 30 and end with 10-30% of your clock left.", 3,
)
STAY_IN_BOOK = Challenge(
    "stay_in_book", "Play your repertoire in 3 games",
    "Rapid or blitz games that follow your repertoire until it runs out.", 3,
)
CHALLENGES = (USE_CLOCK, STAY_IN_BOOK)


def week_start(day: date) -> date:
    return day - timedelta(days=day.weekday())


def used_clock(time_control: str | None, plies: int, last_clock: float | None) -> bool:
    control = parse_control(time_control or "")
    if control is None or last_clock is None or plies < MIN_CLOCK_PLIES:
        return False
    low, high = USED_CLOCK_SHARE
    return control[0] * low <= last_clock <= control[0] * high


async def _last_clocks(session: AsyncSession, games: list) -> dict[int, float]:
    """The player's clock after their last move, per game."""
    if not games:
        return {}
    rows = (
        await session.execute(
            select(GamePosition.game_id, GamePosition.ply, GamePosition.clock_seconds_after).where(
                GamePosition.game_id.in_([game.id for game in games]),
                GamePosition.clock_seconds_after.is_not(None),
            )
        )
    ).all()
    colors = {game.id: game.user_color for game in games}
    last: dict[int, tuple[int, float]] = {}
    for game_id, ply, clock in rows:
        mine = (ply % 2 == 1) == (colors[game_id] == "white")
        if mine and (game_id not in last or ply > last[game_id][0]):
            last[game_id] = (ply, float(clock))
    return {game_id: clock for game_id, (_, clock) in last.items()}


async def challenge_board(
    session: AsyncSession, username: str, repertoires: list[dict], *,
    tz: str | None = None, now: datetime | None = None,
) -> dict:
    """This week's challenges, measured from the games imported so far."""
    now = now or datetime.now(UTC)
    zone = training._zone(tz)
    monday = week_start(now.astimezone(zone).date())
    since = datetime.combine(monday, datetime.min.time(), tzinfo=zone).astimezone(UTC)
    # A coarse cut in SQL (a day either side), the exact local week in Python.
    rows = (
        await session.execute(
            select(Game.id, Game.chesscom_game_url, Game.played_at, Game.user_color, Game.time_class,
                   Game.time_control, Game.num_moves, Game.user_result)
            .where(
                Game.username == username,
                Game.time_class.in_(("rapid", "blitz")),
                Game.played_at >= since - timedelta(days=1),
            )
            .order_by(Game.played_at)
        )
    ).all()
    games = [game for game in rows if training._aware(game.played_at) >= since]
    latest = (
        await session.execute(
            select(Game.played_at).where(Game.username == username)
            .order_by(Game.played_at.desc()).limit(1)
        )
    ).scalar_one_or_none()

    clocks = await _last_clocks(session, [game for game in games if game.time_class == "rapid"])
    clock_games = [
        game for game in games
        if game.time_class == "rapid" and used_clock(game.time_control, game.num_moves or 0, clocks.get(game.id))
    ]
    expected = training_games.expected_moves(repertoires)
    plies = await training_games.opening_plies(session, [game.id for game in games])
    book_games = []
    for game in games:
        met, departure = training_games.first_departure(plies.get(game.id, {}), expected, game.user_color)
        if met and departure is None:
            book_games.append(game)

    week = monday.isoformat()
    claimed = set(
        (
            await session.execute(
                select(TrainingEvent.request_id).where(
                    TrainingEvent.username == username,
                    TrainingEvent.request_id.in_([f"challenge:{week}:{c.key}" for c in CHALLENGES]),
                )
            )
        ).scalars().all()
    )
    items = []
    for challenge, counted in ((USE_CLOCK, clock_games), (STAY_IN_BOOK, book_games)):
        items.append({
            "key": challenge.key,
            "title": challenge.title,
            "description": challenge.description,
            "target": challenge.target,
            "progress": min(challenge.target, len(counted)),
            "done": len(counted) >= challenge.target,
            "claimed": f"challenge:{week}:{challenge.key}" in claimed,
            "xp": training.XP["challenge_done"],
            "games": [
                {"url": game.chesscom_game_url, "played_at": training._aware(game.played_at).isoformat(),
                 "result": game.user_result}
                for game in counted[-challenge.target:]
            ],
        })
    return {
        "week": week,
        "ends": (monday + timedelta(days=6)).isoformat(),
        "games_this_week": len(games),
        "latest_game": training._aware(latest).isoformat() if latest else None,
        "items": items,
    }


async def settle_challenges(
    session: AsyncSession, username: str, repertoires: list[dict], *,
    tz: str | None = None, now: datetime | None = None,
) -> tuple[dict, int, list[str]]:
    """The board, the XP just paid, and the challenges that paid it."""
    board = await challenge_board(session, username, repertoires, tz=tz, now=now)
    xp = 0
    paid: list[str] = []
    for item in board["items"]:
        if item["done"] and not item["claimed"]:
            gained = await training.award(
                session, username, "challenge_done",
                detail={"challenge": item["key"], "week": board["week"]},
                request_id=f"challenge:{board['week']}:{item['key']}",
            )
            if gained:
                xp += gained
                paid.append(item["key"])
                item["claimed"] = True
    return board, xp, paid
