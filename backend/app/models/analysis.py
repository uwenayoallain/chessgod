from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.engine_contract import ENGINE_NAME, ENGINE_VERSION
from app.models.base import Base


class AnalysisResult(Base):
    __tablename__ = "analysis_results"
    # One row per searched depth: a move is graded by differencing two
    # positions, so both sides need a depth they were actually searched to.
    # See alembic/versions/017_analysis_depth_rows.py.
    __table_args__ = (
        UniqueConstraint("position_id", "engine", "multipv_rank", "depth"),
        # Only the active engine contract belongs here. Every learning query
        # filters on it, so a row from any other engine can never grade a
        # decision — it would only inflate the table and blur what "analyzed"
        # means. Cloud and superseded-engine rows live in their own tables
        # (migration 018).
        CheckConstraint(
            f"engine = '{ENGINE_NAME}' AND engine_version = '{ENGINE_VERSION}'",
            name="ck_analysis_results_engine_contract",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    position_id: Mapped[int] = mapped_column(ForeignKey("positions.id"), index=True)
    engine: Mapped[str] = mapped_column(Text, default=ENGINE_NAME)
    engine_version: Mapped[str | None] = mapped_column(Text, default=ENGINE_VERSION, nullable=True)
    depth: Mapped[int] = mapped_column(Integer)
    eval_cp: Mapped[int | None] = mapped_column(Integer, nullable=True)
    eval_mate: Mapped[int | None] = mapped_column(Integer, nullable=True)
    best_move_uci: Mapped[str] = mapped_column(Text)
    best_move_san: Mapped[str] = mapped_column(Text)
    pv_uci: Mapped[str | None] = mapped_column(Text, nullable=True)
    pv_san: Mapped[str | None] = mapped_column(Text, nullable=True)
    multipv_rank: Mapped[int] = mapped_column(Integer, default=1)
    analyzed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
