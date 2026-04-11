from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class PositionMove(Base):
    __tablename__ = "position_moves"
    __table_args__ = (UniqueConstraint("from_position_id", "move_uci"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    from_position_id: Mapped[int] = mapped_column(ForeignKey("positions.id"), index=True)
    to_position_id: Mapped[int] = mapped_column(ForeignKey("positions.id"), index=True)
    move_san: Mapped[str] = mapped_column(Text)
    move_uci: Mapped[str] = mapped_column(Text)
    move_number: Mapped[int] = mapped_column(Integer)
    is_white_move: Mapped[bool] = mapped_column(Boolean)
    game_count: Mapped[int] = mapped_column(Integer, default=0)
    white_wins: Mapped[int] = mapped_column(Integer, default=0)
    draws: Mapped[int] = mapped_column(Integer, default=0)
    black_wins: Mapped[int] = mapped_column(Integer, default=0)
    avg_opponent_rating: Mapped[float | None] = mapped_column(Float, nullable=True)
    master_game_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    master_white_wins: Mapped[int | None] = mapped_column(Integer, nullable=True)
    master_draws: Mapped[int | None] = mapped_column(Integer, nullable=True)
    master_black_wins: Mapped[int | None] = mapped_column(Integer, nullable=True)
    master_fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
