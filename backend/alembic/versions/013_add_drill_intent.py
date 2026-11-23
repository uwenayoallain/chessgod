from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "013_add_drill_intent"
down_revision = "012_add_move_clocks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "drill_attempts",
        sa.Column("intent_key", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("drill_attempts", "intent_key")
