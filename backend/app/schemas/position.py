from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class PositionOut(BaseModel):
    id: int
    fen: str
    total_games: int
    white_wins: int
    draws: int
    black_wins: int

    model_config = ConfigDict(from_attributes=True)
