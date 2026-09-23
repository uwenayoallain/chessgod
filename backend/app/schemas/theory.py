from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.tree import TreeNodeOut


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
    representative_game_id: int | None = None
    representative_game_ply: int | None = None
    representative_post_fen: str | None = None
    representative_played_at: datetime | None = None
    representative_user_result: str | None = None


class FamilySummaryOut(BaseModel):
    id: int
    parent_id: int | None = None
    full_name: str
    display_name: str
    eco: str | None = None
    root_fen: str
    pgn: str
    depth: int
    is_main_line: bool
    child_count: int = 0
    user_game_count: int = 0
    user_win_rate: float = 0.0


class FamilyDetailOut(BaseModel):
    family: FamilySummaryOut
    ancestors: list[FamilySummaryOut]
    children: list[FamilySummaryOut]
    position_tree: TreeNodeOut
    top_mistakes: list["MistakeOut"] = []


class MistakeOut(BaseModel):
    parent_fen: str
    ply: int
    user_move: TheoryMove
    best_move: TheoryMove
    eval_drop_cp: int
    severity: str
    occurrences: int
    family_id: int | None = None
    family_name: str | None = None


class RepertoireNodeOut(BaseModel):
    fen: str
    move: TheoryMove | None = None
    game_count: int = 0
    win_rate: float = 0.0
    marked: bool = False
    is_user_turn: bool = False
    is_hole: bool = False
    children: list["RepertoireNodeOut"] = []


class RepertoireTreeOut(BaseModel):
    username: str
    color: str
    root: RepertoireNodeOut


class RepertoireMarkIn(BaseModel):
    username: str
    fen: str
    color: Literal["white", "black"]
    intended_move_uci: str
    intended_move_san: str
    family_id: int | None = None
    note: str | None = None


class RepertoireMarkOut(RepertoireMarkIn):
    id: int
    marked_at: datetime


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


class QuizMoveOut(BaseModel):
    uci: str
    san: str
    count: int
    share: float


class OpeningQuizPositionOut(BaseModel):
    position_id: int
    fen: str
    ply: int
    side_to_move: str
    occurrences: int
    opening_name: str | None = None
    last_move_uci: str | None = None
    user_moves: list[QuizMoveOut]
    book_moves: list[QuizMoveOut]
    usual_move_in_book: bool
