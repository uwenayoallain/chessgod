from __future__ import annotations

from sqlalchemy import Float, ForeignKey, Integer, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class GamePosition(Base):
    __tablename__ = "game_positions"
    __table_args__ = (UniqueConstraint("game_id", "ply"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), index=True)
    position_id: Mapped[int] = mapped_column(ForeignKey("positions.id"), index=True)
    ply: Mapped[int] = mapped_column(Integer)
    move_san: Mapped[str | None] = mapped_column(Text, nullable=True)
    move_uci: Mapped[str | None] = mapped_column(Text, nullable=True)
    clock_seconds_after: Mapped[float | None] = mapped_column(Float, nullable=True)
    think_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
