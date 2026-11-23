from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class OpeningFamily(Base):
    __tablename__ = "opening_families"

    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("opening_families.id"), nullable=True, index=True)
    full_name: Mapped[str] = mapped_column(Text, unique=True)
    display_name: Mapped[str] = mapped_column(Text)
    eco: Mapped[str | None] = mapped_column(Text, nullable=True)
    root_fen: Mapped[str] = mapped_column(Text, index=True)
    pgn: Mapped[str] = mapped_column(Text)
    depth: Mapped[int] = mapped_column(Integer)
    is_main_line: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    parent: Mapped["OpeningFamily | None"] = relationship(
        "OpeningFamily",
        back_populates="children",
        remote_side=[id],
    )
    children: Mapped[list["OpeningFamily"]] = relationship(
        "OpeningFamily",
        back_populates="parent",
    )
