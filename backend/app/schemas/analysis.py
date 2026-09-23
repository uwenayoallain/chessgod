from __future__ import annotations

from datetime import datetime
from typing import Literal

import chess
from pydantic import BaseModel, Field, model_validator

from app.utils.fen import normalize_fen


class AnalysisEvaluationItemIn(BaseModel):
    fen: str = Field(max_length=120)
    depth: int = Field(ge=1, le=128)
    eval_cp: int | None = Field(default=None, ge=-32_000, le=32_000)
    eval_mate: int | None = Field(default=None, ge=-1_000, le=1_000)
    best_move_uci: str = Field(pattern=r"^[a-h][1-8][a-h][1-8][qrbn]?$")
    best_move_san: str = Field(default="", max_length=20)
    pv_uci: str | None = Field(default=None, max_length=1536)
    pv_san: str | None = Field(default=None, max_length=4096)
    multipv_rank: int = Field(default=1, ge=1, le=256)
    engine: Literal["stockfish-19"] = "stockfish-19"
    engine_version: Literal["19"] = "19"

    @model_validator(mode="after")
    def validate_chess_analysis(self) -> AnalysisEvaluationItemIn:
        if (self.eval_cp is None) == (self.eval_mate is None):
            raise ValueError("Exactly one centipawn or mate score is required")
        # Mate zero describes an already checkmated root, which has no legal PV.
        if self.eval_mate == 0:
            raise ValueError("A playable principal variation cannot have a mate-zero score")
        if len(self.fen.split()) not in (4, 6):
            raise ValueError("Expected a four- or six-field FEN")
        board = chess.Board(self.fen if len(self.fen.split()) == 6 else f"{self.fen} 0 1")
        if not board.is_valid():
            raise ValueError("Invalid chess position")
        self.fen = normalize_fen(board.fen())
        moves = (self.pv_uci or self.best_move_uci).split()
        if not moves or moves[0] != self.best_move_uci or len(moves) > 256:
            raise ValueError("The principal variation must start with the best move and have at most 256 plies")
        sans: list[str] = []
        for uci in moves:
            move = chess.Move.from_uci(uci)
            if move not in board.legal_moves:
                raise ValueError("The principal variation contains an illegal move")
            sans.append(board.san(move))
            board.push(move)
        self.best_move_san = sans[0]
        self.pv_uci = " ".join(moves)
        self.pv_san = " ".join(sans)
        return self


class AnalysisEvaluationBatchIn(BaseModel):
    items: list[AnalysisEvaluationItemIn] = Field(max_length=100)


class AnalysisEvaluationOut(BaseModel):
    depth: int
    eval_cp: int | None = None
    eval_mate: int | None = None
    best_move_uci: str
    pv_uci: str | None = None
    multipv_rank: int = 1
    engine: Literal["stockfish-19"] = "stockfish-19"


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


_UCI_MOVE = r"^[a-h][1-8][a-h][1-8][qrbn]?$"


class MoveExplanationIn(BaseModel):
    """One graded move from a review, with the lines either side of it."""

    fen: str = Field(max_length=120)  # the position the move was played from
    ply: int = Field(ge=1, le=1000)
    user_move_uci: str = Field(pattern=_UCI_MOVE)
    best_move_uci: str = Field(pattern=_UCI_MOVE)
    best_pv_uci: str | None = Field(default=None, max_length=1536)
    reply_pv_uci: str | None = Field(default=None, max_length=1536)
    parent_eval_cp: int = Field(ge=-2000, le=2000)  # White's view, mate mapped onto ±2000
    best_eval_mate: int | None = Field(default=None, ge=-1000, le=1000)
    eval_drop_cp: int = Field(ge=0, le=4000)


class MoveExplanationsIn(BaseModel):
    items: list[MoveExplanationIn] = Field(max_length=40)


class MoveExplanationOut(BaseModel):
    ply: int
    key: str
    label: str
    # The board fact behind the label, when there is one ("Kxf7 wins the queen").
    detail: str | None = None
    cue: str
