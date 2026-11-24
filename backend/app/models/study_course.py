from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, BigInteger, DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.identity import Username


class StudyCourse(Base):
    __tablename__ = "study_courses"

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True)
    username: Mapped[str] = mapped_column(Username, index=True)
    title: Mapped[str] = mapped_column(Text)
    color: Mapped[str] = mapped_column(Text)
    source_type: Mapped[str] = mapped_column(Text)
    source_ref: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StudyChapter(Base):
    __tablename__ = "study_chapters"

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True)
    course_id: Mapped[int] = mapped_column(
        ForeignKey("study_courses.id", ondelete="CASCADE"), index=True,
    )
    position: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(Text)
    start_fen: Mapped[str] = mapped_column(Text)
    pgn: Mapped[str] = mapped_column(Text)
    lines_json: Mapped[list[dict]] = mapped_column(JSON)
