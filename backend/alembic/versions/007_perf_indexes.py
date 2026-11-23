from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "007_perf_indexes"
down_revision = "006_add_analysis_requests"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Partial covering index for the best_evals CTE in find_mistakes.
    # Filters to rank-1 rows with a real eval, sorts by depth so DISTINCT ON /
    # ROW_NUMBER is served by a single forward index scan, and INCLUDEs the
    # payload columns to avoid a heap fetch per row on PostgreSQL.
    op.create_index(
        "idx_ar_rank1_depth",
        "analysis_results",
        ["position_id", sa.text("depth DESC"), sa.text("id DESC")],
        postgresql_include=["eval_cp", "best_move_uci", "best_move_san"],
        postgresql_where=sa.text("multipv_rank = 1 AND eval_cp IS NOT NULL"),
    )

    # Index for the master_top3 CTE: lets the window function PARTITION BY
    # from_position_id ORDER BY master_game_count DESC run as an index scan
    # rather than a sort.
    op.create_index(
        "idx_pm_master_order",
        "position_moves",
        [
            "from_position_id",
            sa.text("master_game_count DESC"),
            sa.text("game_count DESC"),
        ],
        postgresql_where=sa.text("master_game_count IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("idx_pm_master_order", table_name="position_moves")
    op.drop_index("idx_ar_rank1_depth", table_name="analysis_results")
