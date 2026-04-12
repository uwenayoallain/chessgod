from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class TheoryMove(BaseModel):
    san: str
    uci: str | None = None
    game_count: int
    win_rate: float | None = None


class DeviationOut(BaseModel):
    fen: str
    move_number: int
    user_top_move: TheoryMove
    master_top_move: TheoryMove
    eco: str | None = None
    opening_name: str | None = None
    severity: str


class TheoryComparisonOut(BaseModel):
    fen: str
    user_moves: list[TheoryMove]
    master_moves: list[TheoryMove]
    eco: str | None = None
    opening_name: str | None = None
    master_data_state: Literal["seeded", "synced", "missing"] = "missing"


class TrainingMoveOut(BaseModel):
    ply: int
    fen: str
    san: str
    uci: str
    resulting_fen: str


class TrainingLineOut(BaseModel):
    eco: str | None = None
    opening_name: str
    source_game_id: int
    moves: list[TrainingMoveOut]
