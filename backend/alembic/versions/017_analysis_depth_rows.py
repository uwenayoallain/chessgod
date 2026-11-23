"""Keep one analysis row per searched depth, not only the deepest.

Migration 005 collapsed the key to (position, engine, multipv_rank) so a
position carried its deepest search and nothing else. That is right for
displaying a position and wrong for measuring a move: an evaluation loss is the
difference between two positions, so the parent and the child have to be
compared at a depth they were both searched to. With only the deepest row kept,
a parent that the player happened to open on the board at depth 30 was
differenced against a child the crawl left at depth 22, and the gap between the
two searches was reported as the player's mistake. Restoring depth to the key
lets a decision pick a depth both sides share; readers that want the strongest
evaluation of a single position still order by depth and take the first row.
"""

from __future__ import annotations

from alembic import op


revision = "017_analysis_depth_rows"
down_revision = "016_drill_attempt_receipts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint(
        "uq_analysis_results_position_engine_mpv",
        "analysis_results",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_analysis_results_position_engine_mpv_depth",
        "analysis_results",
        ["position_id", "engine", "multipv_rank", "depth"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_analysis_results_position_engine_mpv_depth",
        "analysis_results",
        type_="unique",
    )
    # Collapsing back to one row per position has to discard the shallower
    # searches the wider key allowed.
    op.execute("""
        DELETE FROM analysis_results a
        USING analysis_results b
        WHERE a.position_id = b.position_id
          AND a.engine = b.engine
          AND a.multipv_rank = b.multipv_rank
          AND (a.depth < b.depth OR (a.depth = b.depth AND a.id < b.id))
    """)
    op.create_unique_constraint(
        "uq_analysis_results_position_engine_mpv",
        "analysis_results",
        ["position_id", "engine", "multipv_rank"],
    )
