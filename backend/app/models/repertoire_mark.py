from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.identity import Username


class RepertoireMark(Base):
    __tablename__ = "repertoire_marks"
    __table_args__ = (UniqueConstraint("username", "fen", "color"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(Username, index=True)
    fen: Mapped[str] = mapped_column(Text)
    color: Mapped[str] = mapped_column(Text, index=True)
    intended_move_uci: Mapped[str] = mapped_column(Text)
    intended_move_san: Mapped[str] = mapped_column(Text)
    family_id: Mapped[int | None] = mapped_column(ForeignKey("opening_families.id"), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    marked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
