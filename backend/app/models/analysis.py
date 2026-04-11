from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AnalysisResult(Base):
    __tablename__ = "analysis_results"
    __table_args__ = (UniqueConstraint("position_id", "engine", "depth", "multipv_rank"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    position_id: Mapped[int] = mapped_column(ForeignKey("positions.id"), index=True)
    engine: Mapped[str] = mapped_column(Text, default="stockfish")
    engine_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    depth: Mapped[int] = mapped_column(Integer)
    eval_cp: Mapped[int | None] = mapped_column(Integer, nullable=True)
    eval_mate: Mapped[int | None] = mapped_column(Integer, nullable=True)
    best_move_uci: Mapped[str] = mapped_column(Text)
    best_move_san: Mapped[str] = mapped_column(Text)
    pv_uci: Mapped[str | None] = mapped_column(Text, nullable=True)
    pv_san: Mapped[str | None] = mapped_column(Text, nullable=True)
    multipv_rank: Mapped[int] = mapped_column(Integer, default=1)
    analyzed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
