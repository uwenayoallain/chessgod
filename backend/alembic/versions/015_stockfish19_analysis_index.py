"""Index the active Stockfish 19 evidence path."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "015_stockfish19_analysis_index"
down_revision = "014_position_outcomes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Improvement, coverage, and hydration queries all start from trusted
    # rank-one Stockfish 19 rows at or above a requested depth. Keep the
    # provider/version predicate in the partial index so cloud and legacy rows
    # cannot inflate the scan as the imported corpus grows.
    op.create_index(
        "idx_ar_stockfish19_rank1_depth",
        "analysis_results",
        ["position_id", sa.text("depth DESC"), sa.text("id DESC")],
        postgresql_include=[
            "eval_cp",
            "eval_mate",
            "best_move_uci",
            "best_move_san",
            "pv_uci",
        ],
        postgresql_where=sa.text(
            "engine = 'stockfish-19' AND engine_version = '19' "
            "AND multipv_rank = 1 AND (eval_cp IS NOT NULL OR eval_mate IS NOT NULL)"
        ),
    )


def downgrade() -> None:
    op.drop_index("idx_ar_stockfish19_rank1_depth", table_name="analysis_results")
