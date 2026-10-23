from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

_UCI = r"^[a-h][1-8][a-h][1-8][qrbn]?$"


class SparringGameIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    user_color: Literal["white", "black"]
    engine_rating: int = Field(ge=100, le=4000)
    rated: bool
    result: Literal["win", "loss", "draw"]
    reason: str = Field(min_length=1, max_length=40)
    start_fen: str = Field(min_length=10, max_length=100)
    moves_uci: list[str] = Field(default_factory=list, max_length=600)
    time_control_seconds: int | None = Field(default=None, ge=10, le=7200)
    # Where the game came from: "boss:<line id>" when it was played from the end
    # of a repertoire line. Not stored; it only decides the XP.
    origin: str | None = Field(default=None, max_length=60, pattern=r"^[a-z]+:[A-Za-z0-9_-]+$")
    tz: str | None = Field(default=None, max_length=64)


class SparringGameCreated(BaseModel):
    id: int
    # XP the game earned (services/training.py), a boss fight's included.
    xp_gained: int = 0


class SparringMistakeIn(BaseModel):
    fen: str = Field(min_length=10, max_length=100)
    ply: int = Field(ge=1, le=600)
    user_move_uci: str = Field(pattern=_UCI)
    user_move_san: str = Field(min_length=1, max_length=12)
    best_move_uci: str = Field(pattern=_UCI)
    best_pv_uci: str | None = Field(default=None, max_length=800)
    reply_pv_uci: str | None = Field(default=None, max_length=800)
    previous_move_uci: str | None = Field(default=None, pattern=_UCI)
    parent_eval_cp: int = Field(ge=-2000, le=2000)
    parent_eval_mate: int | None = Field(default=None, ge=-100, le=100)
    eval_drop_cp: int = Field(ge=0, le=4000)
    # The review's search of the position, stored as evidence so the drill is
    # graded against the same line it quotes. The review searches positions
    # nobody imported, so the evaluation upload skips them.
    depth: int = Field(ge=18, le=128)


class SparringMistakesIn(BaseModel):
    mistakes: list[SparringMistakeIn] = Field(default_factory=list, max_length=80)


class SparringMistakesStored(BaseModel):
    stored: int


class SparringGameOut(BaseModel):
    id: int
    user_color: str
    engine_rating: int
    rated: bool
    result: str
    reason: str
    moves: int
    mistakes: int
    time_control_seconds: int | None
    played_at: datetime
    # The game itself, so a past game can be put back on the board and reviewed.
    start_fen: str
    moves_uci: list[str]


class SparringSummaryOut(BaseModel):
    played: int
    wins: int
    draws: int
    losses: int
    # Rated games only: the strength the calibration walk has reached.
    rated_played: int
    first_rating: int | None
    latest_rating: int | None


class SparringHistoryOut(BaseModel):
    summary: SparringSummaryOut
    games: list[SparringGameOut]
