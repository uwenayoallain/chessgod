from __future__ import annotations

from pydantic import BaseModel


class MoveOut(BaseModel):
    san: str
    uci: str
    game_count: int
    white_wins: int
    draws: int
    black_wins: int
    avg_opponent_rating: float | None = None
    resulting_fen: str
    is_book_move: bool = False
    master_game_count: int | None = None
    master_white_wins: int | None = None
    master_draws: int | None = None
    master_black_wins: int | None = None


class TreeNodeOut(BaseModel):
    fen: str
    total_games: int
    white_wins: int
    draws: int
    black_wins: int
    moves: list[MoveOut]
