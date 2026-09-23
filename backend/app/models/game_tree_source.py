"""One global tree contribution per physical game, across player imports."""
from sqlalchemy import Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class GameTreeSource(Base):
    __tablename__ = "game_tree_sources"
    game_url: Mapped[str] = mapped_column(Text, primary_key=True)
