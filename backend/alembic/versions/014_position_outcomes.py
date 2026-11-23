"""Keep rules-proven outcomes separate from searched engine evaluations."""

import sqlalchemy as sa
from alembic import op

revision = "014_position_outcomes"
down_revision = "013_add_drill_intent"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "position_outcomes",
        sa.Column("position_id", sa.Integer(), sa.ForeignKey("positions.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("white_result", sa.Integer(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.CheckConstraint("white_result IN (-1, 0, 1)"),
    )


def downgrade() -> None:
    op.drop_table("position_outcomes")
