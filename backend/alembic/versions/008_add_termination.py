from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "008_add_termination"
down_revision = "007_perf_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("games", sa.Column("termination", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("games", "termination")
