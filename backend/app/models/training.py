from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, Index, Integer, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.identity import Username


class LineMoveProgress(Base):
    """How well the player knows one repertoire move, MoveTrainer style.

    Keyed by position and move, not by line: a move that several lines share
    (every Black line starts 1.e4 e5) is learnt once, and a transposition
    reaches the same memory by any move order.
    """

    __tablename__ = "line_move_progress"
    __table_args__ = (UniqueConstraint("username", "fen", "move_uci"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(Username, index=True)
    color: Mapped[str] = mapped_column(Text)
    fen: Mapped[str] = mapped_column(Text)
    move_uci: Mapped[str] = mapped_column(Text)
    # 0 = introduced, never recalled; 1-8 = the review interval ladder.
    level: Mapped[int] = mapped_column(Integer, default=0)
    reviews: Mapped[int] = mapped_column(Integer, default=0)
    # Correct answers from memory (practice mode, due or early). Learning a move
    # with the hint showing is not a recall; the first recall is what makes a
    # learned line one to practise rather than one to learn again.
    recalls: Mapped[int] = mapped_column(Integer, default=0)
    lapses: Mapped[int] = mapped_column(Integer, default=0)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    last_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TrainingEvent(Base):
    """Append-only record of training done, and the XP it earned.

    Streaks, levels and achievements are all computed from this, so none of
    them can drift from what actually happened.
    """

    __tablename__ = "training_events"
    __table_args__ = (
        Index("ix_training_events_user_time", "username", "created_at"),
        Index("uq_training_events_request", "username", "request_id", unique=True),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(Username)
    kind: Mapped[str] = mapped_column(Text)
    xp: Mapped[int] = mapped_column(Integer)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
