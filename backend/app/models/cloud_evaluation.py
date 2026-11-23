from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class CloudEvaluation(Base):
    """A Lichess cloud evaluation, kept apart from the engine contract on purpose.

    These are somebody else's searches, at depths we did not choose and from a
    build we cannot pin. Differencing one against our own would charge the gap
    between two engines to the player, so they are never a learning source. They
    lived in ``analysis_results`` until migration 018, where the only thing
    separating them from trusted rows was the value of a string column.
    """

    __tablename__ = "cloud_evaluations"

    id: Mapped[int] = mapped_column(primary_key=True)
    position_id: Mapped[int] = mapped_column(ForeignKey("positions.id"), index=True)
    engine: Mapped[str] = mapped_column(Text, default="lichess-cloud")
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
