from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.identity import Username


class SparringGame(Base):
    """A game the player played against the engine opponent in the app.

    Kept apart from `games`: those are Chess.com imports and feed the opening
    tree, stats and the analysis queue, none of which a practice game belongs in.
    """

    __tablename__ = "sparring_games"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(Username, index=True)
    user_color: Mapped[str] = mapped_column(Text)
    engine_rating: Mapped[int] = mapped_column(Integer)
    rated: Mapped[bool] = mapped_column(Boolean, default=False)
    # 'win' | 'loss' | 'draw' from the player's side.
    result: Mapped[str] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(Text)
    start_fen: Mapped[str] = mapped_column(Text)
    moves_uci: Mapped[str] = mapped_column(Text, default="")
    # Clock in seconds per side, or null for an untimed game.
    time_control_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    played_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class SparringMistake(Base):
    """A move the post-game review graded as a mistake, kept for drilling."""

    __tablename__ = "sparring_mistakes"

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(
        ForeignKey("sparring_games.id", ondelete="CASCADE"), index=True
    )
    position_id: Mapped[int] = mapped_column(
        ForeignKey("positions.id", ondelete="CASCADE"), index=True
    )
    ply: Mapped[int] = mapped_column(Integer)
    user_move_uci: Mapped[str] = mapped_column(Text)
    user_move_san: Mapped[str] = mapped_column(Text)
    best_move_uci: Mapped[str] = mapped_column(Text)
    best_pv_uci: Mapped[str | None] = mapped_column(Text, nullable=True)
    reply_pv_uci: Mapped[str | None] = mapped_column(Text, nullable=True)
    previous_move_uci: Mapped[str | None] = mapped_column(Text, nullable=True)
    # White's view, as analysis_results stores it.
    parent_eval_cp: Mapped[int] = mapped_column(Integer)
    parent_eval_mate: Mapped[int | None] = mapped_column(Integer, nullable=True)
    eval_drop_cp: Mapped[int] = mapped_column(Integer)
