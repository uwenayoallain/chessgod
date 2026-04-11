from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Position(Base):
    __tablename__ = "positions"

    id: Mapped[int] = mapped_column(primary_key=True)
    fen: Mapped[str] = mapped_column(Text, unique=True, index=True)
    total_games: Mapped[int] = mapped_column(Integer, default=0)
    white_wins: Mapped[int] = mapped_column(Integer, default=0)
    draws: Mapped[int] = mapped_column(Integer, default=0)
    black_wins: Mapped[int] = mapped_column(Integer, default=0)
    master_total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    master_white: Mapped[int | None] = mapped_column(Integer, nullable=True)
    master_draws: Mapped[int | None] = mapped_column(Integer, nullable=True)
    master_black: Mapped[int | None] = mapped_column(Integer, nullable=True)
    master_eco: Mapped[str | None] = mapped_column(Text, nullable=True)
    master_opening_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    master_fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
