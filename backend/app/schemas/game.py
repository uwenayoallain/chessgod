from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class GameOut(BaseModel):
    id: int
    chesscom_game_url: str
    username: str
    white_username: str
    black_username: str
    white_rating: int | None = None
    black_rating: int | None = None
    user_color: str
    result: str
    user_result: str
    time_class: str
    eco: str | None = None
    opening_name: str | None = None
    played_at: datetime
    num_moves: int | None = None
    pgn: str | None = None

    model_config = ConfigDict(from_attributes=True)


class GameListOut(BaseModel):
    games: list[GameOut]
    total: int
    page: int
    per_page: int


class OpeningGroupOut(BaseModel):
    eco: str | None = None
    opening_name: str
    game_count: int
    wins: int
    losses: int
    draws: int
    latest_played_at: datetime
    representative_game_id: int


class OpeningGroupListOut(BaseModel):
    openings: list[OpeningGroupOut]
    total: int
    page: int
    per_page: int


class OpeningPreviewOut(BaseModel):
    eco: str | None = None
    opening_name: str
    representative_game: GameOut


class ColorStats(BaseModel):
    wins: int = 0
    losses: int = 0
    draws: int = 0


class OpeningStat(BaseModel):
    opening_name: str
    games: int


class TimeClassStats(BaseModel):
    games: int = 0
    wins: int = 0
    losses: int = 0
    draws: int = 0
    win_rate: float = 0.0


class GameStatsOut(BaseModel):
    total_games: int = 0
    win_rate: float = 0.0
    by_color: dict[str, ColorStats] = {}
    by_time_class: dict[str, TimeClassStats] = {}
    by_opening: list[OpeningStat] = []


class OpeningDetailStat(BaseModel):
    eco: str | None = None
    opening_name: str
    game_count: int
    wins: int
    losses: int
    draws: int
    win_rate: float
    avg_rating: float | None = None
