from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.identity import Username


class Game(Base):
    __tablename__ = "games"
    __table_args__ = (UniqueConstraint("chesscom_game_url", "username", name="uq_games_url_player"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    chesscom_game_url: Mapped[str] = mapped_column(Text, index=True)
    chesscom_game_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    username: Mapped[str] = mapped_column(Username, index=True)
    white_username: Mapped[str] = mapped_column(Text)
    black_username: Mapped[str] = mapped_column(Text)
    user_color: Mapped[str] = mapped_column(Text)
    result: Mapped[str] = mapped_column(Text)
    user_result: Mapped[str] = mapped_column(Text, index=True)
    time_class: Mapped[str] = mapped_column(Text, index=True)
    time_control: Mapped[str | None] = mapped_column(Text, nullable=True)
    white_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    black_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pgn: Mapped[str] = mapped_column(Text)
    eco: Mapped[str | None] = mapped_column(Text, nullable=True)
    opening_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    played_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    num_moves: Mapped[int | None] = mapped_column(Integer, nullable=True)
    termination: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
