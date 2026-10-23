from __future__ import annotations

from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.models.game import Game


RAPID_BLITZ = "rapid_blitz"
# Games played below this are left out of the learning pipeline: they come
# from before the player could play, and teach habits they have since lost.
DEFAULT_MIN_USER_RATING = 1_000
# How far below the player's current rating the floor may sit.
RATING_FLOOR_MARGIN = 200
LOWEST_RATING_FLOOR = 100


def time_class_condition(column, value: str | None) -> ColumnElement[bool] | None:
    """Translate the product's combined rapid/blitz scope into one SQL condition."""

    if not value:
        return None
    if value == RAPID_BLITZ:
        return column.in_(("rapid", "blitz"))
    return column == value


# Chess.com writes this header on Chess960 games. Their positions use castling
# rights standard chess cannot express, so the evaluations endpoint refuses
# every one: 27 games and 1,075 positions here, counted as "missing" forever and
# read first by the queue's newest-first fallback. Other games from a set-up
# position are ordinary chess and stay in.
CHESS960_HEADER = '[Variant "Chess960"]'


def standard_rules_condition(game) -> ColumnElement[bool]:
    """Games played under standard rules, which every analysis surface can store."""

    return ~game.pgn.contains(CHESS960_HEADER, autoescape=True)


def user_rating_condition(game, min_rating: int) -> ColumnElement[bool]:
    """Filter on the imported user's rating, independent of board color."""

    return case(
        (game.user_color == "white", game.white_rating),
        else_=game.black_rating,
    ) >= min_rating


async def player_rating_floor(session: AsyncSession, username: str) -> int:
    """The rating below which this player's games are left out of learning.

    A fixed 1,000 was right for a player who has climbed past it — it drops the
    games from before they could play — but it dropped *every* game of a player
    who has not: the analysis queue, the coverage count and the drill plan all
    came back empty for someone rated 800, who is exactly who most needs them.
    The floor now follows the player: never above 1,000, and always at least
    `RATING_FLOOR_MARGIN` below their current rating in whichever of rapid and
    blitz is lower, so a weaker time control is not filtered out by a stronger
    one. A player with no rated games keeps the default.
    """

    rating = case(
        (Game.user_color == "white", Game.white_rating),
        else_=Game.black_rating,
    )
    current: list[int] = []
    for time_class in ("rapid", "blitz"):
        latest = (
            await session.execute(
                select(rating)
                .where(
                    Game.username == username,
                    Game.time_class == time_class,
                    rating.is_not(None),
                )
                .order_by(Game.played_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if latest is not None:
            current.append(int(latest))
    if not current:
        return DEFAULT_MIN_USER_RATING
    return max(
        LOWEST_RATING_FLOOR,
        min(DEFAULT_MIN_USER_RATING, min(current) - RATING_FLOOR_MARGIN),
    )
