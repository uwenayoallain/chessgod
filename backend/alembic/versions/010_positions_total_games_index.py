from __future__ import annotations

from alembic import op


revision = "010_positions_total_games_index"
down_revision = "009_drop_analysis_requests"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Top-N "most played positions" scans (cloud-eval candidates, master sync
    # ordering) walk this index instead of sorting millions of rows: 4.7s -> 29ms.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_positions_total_games "
        "ON positions (total_games DESC, id ASC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_positions_total_games")
