from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "012_add_move_clocks"
down_revision = "011_add_improvement_drills"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "game_positions",
        sa.Column("clock_seconds_after", sa.Float(), nullable=True),
    )
    op.add_column(
        "game_positions",
        sa.Column("think_seconds", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("game_positions", "think_seconds")
    op.drop_column("game_positions", "clock_seconds_after")
