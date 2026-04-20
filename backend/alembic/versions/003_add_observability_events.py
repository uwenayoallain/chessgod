from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "003_add_observability_events"
down_revision = "002_add_external_sync_state"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "observability_events",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("severity", sa.Text(), nullable=True),
        sa.Column("request_id", sa.Text(), nullable=True),
        sa.Column("method", sa.Text(), nullable=True),
        sa.Column("path", sa.Text(), nullable=True),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("duration_ms", sa.Float(), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("metadata_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("idx_observability_events_created_at", "observability_events", ["created_at"])
    op.create_index("idx_observability_events_request_id", "observability_events", ["request_id"])
    op.create_index("idx_observability_events_source_kind", "observability_events", ["source", "kind"])


def downgrade() -> None:
    op.drop_index("idx_observability_events_source_kind", table_name="observability_events")
    op.drop_index("idx_observability_events_request_id", table_name="observability_events")
    op.drop_index("idx_observability_events_created_at", table_name="observability_events")
    op.drop_table("observability_events")
