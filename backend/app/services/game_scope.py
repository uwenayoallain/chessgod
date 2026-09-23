from __future__ import annotations

from sqlalchemy import case
from sqlalchemy.sql.elements import ColumnElement


RAPID_BLITZ = "rapid_blitz"
DEFAULT_MIN_USER_RATING = 1_000


def time_class_condition(column, value: str | None) -> ColumnElement[bool] | None:
    """Translate the product's combined rapid/blitz scope into one SQL condition."""

    if not value:
        return None
    if value == RAPID_BLITZ:
        return column.in_(("rapid", "blitz"))
    return column == value


def user_rating_condition(game, min_rating: int) -> ColumnElement[bool]:
    """Filter on the imported user's rating, independent of board color."""

    return case(
        (game.user_color == "white", game.white_rating),
        else_=game.black_rating,
    ) >= min_rating
