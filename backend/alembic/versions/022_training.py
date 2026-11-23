"""Repertoire move memory and the training log behind XP, streaks and achievements."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import CITEXT

revision = "022_training"
down_revision = "021_sparring_games"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "line_move_progress",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", CITEXT(), nullable=False),
        sa.Column("color", sa.Text(), nullable=False),
        sa.Column("fen", sa.Text(), nullable=False),
        sa.Column("move_uci", sa.Text(), nullable=False),
        sa.Column("level", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reviews", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lapses", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("username", "fen", "move_uci"),
    )
    op.create_index("ix_line_move_progress_username", "line_move_progress", ["username"])
    op.create_index("ix_line_move_progress_due_at", "line_move_progress", ["due_at"])
    op.create_table(
        "training_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", CITEXT(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("xp", sa.Integer(), nullable=False),
        sa.Column("detail", sa.JSON(), nullable=True),
        sa.Column("request_id", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_training_events_user_time", "training_events", ["username", "created_at"])
    op.create_index("uq_training_events_request", "training_events", ["username", "request_id"], unique=True)


def downgrade() -> None:
    op.drop_table("training_events")
    op.drop_table("line_move_progress")
