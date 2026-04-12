from __future__ import annotations

from pydantic import BaseModel


class ImportProgressEvent(BaseModel):
    type: str
    archive: str | None = None
    index: int | None = None
    total_archives: int | None = None
    games_in_archive: int | None = None
    game_index: int | None = None
    current_game: str | None = None
    new_games: int | None = None
    skipped_games: int | None = None
    total_new_games: int | None = None
    total_skipped: int | None = None
    cached_archives: int | None = None
    cached: bool | None = None
    message: str | None = None


class ImportSummary(BaseModel):
    username: str
    total_games: int
    date_range: dict[str, str | None]
    games_by_time_class: dict[str, int]
