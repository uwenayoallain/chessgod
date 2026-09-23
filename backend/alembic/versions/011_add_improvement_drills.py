from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "011_add_improvement_drills"
down_revision = "010_positions_total_games_index"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "drill_progress",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("username", sa.Text(), nullable=False),
        sa.Column(
            "position_id",
            sa.BigInteger(),
            sa.ForeignKey("positions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("expected_move_uci", sa.Text(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("correct_attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("streak", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("interval_days", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("ease_factor", sa.Float(), nullable=False, server_default="2.0"),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("username", "position_id", "expected_move_uci"),
    )
    op.create_index(
        "idx_drill_progress_user_due",
        "drill_progress",
        ["username", "due_at"],
    )
    op.create_index("idx_drill_progress_position", "drill_progress", ["position_id"])

    op.create_table(
        "drill_attempts",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("username", sa.Text(), nullable=False),
        sa.Column(
            "position_id",
            sa.BigInteger(),
            sa.ForeignKey("positions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("expected_move_uci", sa.Text(), nullable=False),
        sa.Column("played_move_uci", sa.Text(), nullable=False),
        sa.Column("pattern_key", sa.Text(), nullable=False),
        sa.Column("correct", sa.Integer(), nullable=False),
        sa.Column("response_ms", sa.Integer(), nullable=True),
        sa.Column("attempted_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "idx_drill_attempts_user_attempted",
        "drill_attempts",
        ["username", sa.text("attempted_at DESC")],
    )
    op.create_index("idx_drill_attempts_position", "drill_attempts", ["position_id"])


def downgrade() -> None:
    op.drop_index("idx_drill_attempts_position", table_name="drill_attempts")
    op.drop_index("idx_drill_attempts_user_attempted", table_name="drill_attempts")
    op.drop_table("drill_attempts")
    op.drop_index("idx_drill_progress_position", table_name="drill_progress")
    op.drop_index("idx_drill_progress_user_due", table_name="drill_progress")
    op.drop_table("drill_progress")
