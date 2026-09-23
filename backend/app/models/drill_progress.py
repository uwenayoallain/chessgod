from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, Float, ForeignKey, Index, Integer, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.identity import Username


class DrillProgress(Base):
    """Small, pre-aggregated review state for one user and one best-move task."""

    __tablename__ = "drill_progress"
    __table_args__ = (
        UniqueConstraint("username", "position_id", "expected_move_uci"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(Username, index=True)
    position_id: Mapped[int] = mapped_column(
        ForeignKey("positions.id", ondelete="CASCADE"), index=True
    )
    expected_move_uci: Mapped[str] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    correct_attempts: Mapped[int] = mapped_column(Integer, default=0)
    streak: Mapped[int] = mapped_column(Integer, default=0)
    interval_days: Mapped[int] = mapped_column(Integer, default=0)
    ease_factor: Mapped[float] = mapped_column(Float, default=2.0)
    due_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    last_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class DrillAttempt(Base):
    """Append-only evidence used for progress charts and future tuning."""

    __tablename__ = "drill_attempts"
    __table_args__ = (
        Index("uq_drill_attempt_request", "username", "position_id", "request_id", unique=True),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(Username, index=True)
    position_id: Mapped[int] = mapped_column(
        ForeignKey("positions.id", ondelete="CASCADE"), index=True
    )
    expected_move_uci: Mapped[str] = mapped_column(Text)
    played_move_uci: Mapped[str] = mapped_column(Text)
    pattern_key: Mapped[str] = mapped_column(Text)
    # What the player said they were checking before the answer was revealed.
    intent_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    correct: Mapped[int] = mapped_column(Integer)
    response_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    request_fingerprint: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    attempted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
