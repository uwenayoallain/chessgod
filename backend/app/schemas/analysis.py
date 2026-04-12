from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class AnalysisLineIn(BaseModel):
    eval_cp: int | None = None
    eval_mate: int | None = None
    best_move_uci: str
    best_move_san: str
    pv_uci: str | None = None
    pv_san: str | None = None
    multipv_rank: int = 1


class AnalysisResultIn(BaseModel):
    fen: str
    depth: int
    engine: str = "stockfish"
    engine_version: str | None = None
    lines: list[AnalysisLineIn]


class AnalysisResultOut(BaseModel):
    id: int
    position_id: int
    engine: str
    engine_version: str | None = None
    depth: int
    eval_cp: int | None = None
    eval_mate: int | None = None
    best_move_uci: str
    best_move_san: str
    pv_uci: str | None = None
    pv_san: str | None = None
    multipv_rank: int
    analyzed_at: datetime


class RecurringMistakeOut(BaseModel):
    fen: str
    user_move: dict[str, str | int]
    best_move: dict[str, str | int | None]
    user_move_eval_cp: int | None = None
    cp_loss: int
    classification: str
    occurrences: int
    opening_context: str | None = None
