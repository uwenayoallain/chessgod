from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "006_add_analysis_requests"
down_revision = "005_depth_wins_upsert"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # User-opt-in scopes for backend (server-side Stockfish) analysis. The worker
    # only processes positions inside an active request (completed_at IS NULL) and
    # idles entirely when there are none — no more global-corpus churn.
    op.create_table(
        "analysis_requests",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("username", sa.Text(), nullable=False),
        sa.Column("color", sa.Text(), nullable=False, server_default="both"),
        sa.Column("time_class", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_analysis_requests_active", "analysis_requests", ["completed_at"])
    op.create_index("idx_analysis_requests_username", "analysis_requests", ["username"])


def downgrade() -> None:
    op.drop_index("idx_analysis_requests_username", table_name="analysis_requests")
    op.drop_index("idx_analysis_requests_active", table_name="analysis_requests")
    op.drop_table("analysis_requests")
