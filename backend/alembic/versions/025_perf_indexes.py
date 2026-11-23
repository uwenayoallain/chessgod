"""Index recent analysis activity and current ratings by time class."""

import sqlalchemy as sa
from alembic import op

revision = "025_perf_indexes"
down_revision = "024_move_recalls"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_ar_engine_version_analyzed_at",
        "analysis_results",
        ["engine", "engine_version", sa.text("analyzed_at DESC")],
    )
    op.create_index(
        "ix_games_username_time_class_played_at",
        "games",
        ["username", "time_class", sa.text("played_at DESC"), sa.text("id DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_games_username_time_class_played_at", table_name="games")
    op.drop_index("ix_ar_engine_version_analyzed_at", table_name="analysis_results")
