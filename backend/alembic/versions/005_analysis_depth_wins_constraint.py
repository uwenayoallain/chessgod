from __future__ import annotations

from alembic import op


revision = "005_depth_wins_upsert"
down_revision = "004_add_theory_features"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop the old unique constraint that includes depth.
    # With depth in the constraint, each (position, engine, depth, multipv_rank) tuple
    # gets its own row — so d14 and d20 coexist.  We want at most one row per
    # (position, engine, multipv_rank), always the deepest analysis.
    op.drop_constraint(
        "analysis_results_position_id_engine_depth_multipv_rank_key",
        "analysis_results",
        type_="unique",
    )

    # Delete shallower duplicates, keeping only the deepest row per group
    op.execute("""
        DELETE FROM analysis_results a
        USING analysis_results b
        WHERE a.position_id = b.position_id
          AND a.engine = b.engine
          AND a.multipv_rank = b.multipv_rank
          AND (a.depth < b.depth OR (a.depth = b.depth AND a.id < b.id))
    """)

    # Add new unique constraint without depth
    op.create_unique_constraint(
        "uq_analysis_results_position_engine_mpv",
        "analysis_results",
        ["position_id", "engine", "multipv_rank"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_analysis_results_position_engine_mpv",
        "analysis_results",
        type_="unique",
    )
    op.create_unique_constraint(
        "analysis_results_position_id_engine_depth_multipv_rank_key",
        "analysis_results",
        ["position_id", "engine", "depth", "multipv_rank"],
    )
