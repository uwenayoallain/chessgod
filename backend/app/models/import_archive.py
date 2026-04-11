from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ImportArchive(Base):
    __tablename__ = "import_archives"
    __table_args__ = (UniqueConstraint("username", "archive_url"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(Text, index=True)
    archive_url: Mapped[str] = mapped_column(Text)
    archive_month: Mapped[str] = mapped_column(Text, index=True)
    games_in_archive: Mapped[int] = mapped_column(Integer, default=0)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
