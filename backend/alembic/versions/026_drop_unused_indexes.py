"""Drop three unused observability and analysis indexes."""

import sqlalchemy as sa
from alembic import op

revision = "026_drop_unused_indexes"
down_revision = "025_perf_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Observability reads use the time index for recent events. Analysis uses
    # the Stockfish 19 covering index, which also handles mate scores.
    op.execute("DROP INDEX IF EXISTS idx_observability_events_request_id")
    op.execute("DROP INDEX IF EXISTS idx_observability_events_source_kind")
    op.execute("DROP INDEX IF EXISTS idx_ar_rank1_depth")


def downgrade() -> None:
    op.create_index("idx_observability_events_request_id", "observability_events", ["request_id"])
    op.create_index("idx_observability_events_source_kind", "observability_events", ["source", "kind"])
    op.create_index(
        "idx_ar_rank1_depth",
        "analysis_results",
        ["position_id", sa.text("depth DESC"), sa.text("id DESC")],
        postgresql_include=["eval_cp", "best_move_uci", "best_move_san"],
        postgresql_where=sa.text("multipv_rank = 1 AND eval_cp IS NOT NULL"),
    )
