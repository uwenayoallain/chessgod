from sqlalchemy import CheckConstraint, ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class PositionOutcome(Base):
    """Rules-proven final board results, never presented as engine searches."""

    __tablename__ = "position_outcomes"
    __table_args__ = (CheckConstraint("white_result IN (-1, 0, 1)"),)

    position_id: Mapped[int] = mapped_column(ForeignKey("positions.id", ondelete="CASCADE"), primary_key=True)
    white_result: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(Text)
