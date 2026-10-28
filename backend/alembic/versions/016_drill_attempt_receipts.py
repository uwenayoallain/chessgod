"""Persist answer receipts so transport retries cannot inflate learning evidence."""

import sqlalchemy as sa
from alembic import op

revision = "016_drill_attempt_receipts"
down_revision = "015_stockfish19_analysis_index"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("drill_attempts", sa.Column("request_id", sa.Text(), nullable=True))
    op.add_column("drill_attempts", sa.Column("request_fingerprint", sa.Text(), nullable=True))
    op.add_column("drill_attempts", sa.Column("result_snapshot", sa.JSON(), nullable=True))
    op.create_index("uq_drill_attempt_request", "drill_attempts",
                    ["username", "position_id", "request_id"], unique=True)


def downgrade() -> None:
    op.drop_index("uq_drill_attempt_request", table_name="drill_attempts")
    op.drop_column("drill_attempts", "result_snapshot")
    op.drop_column("drill_attempts", "request_fingerprint")
    op.drop_column("drill_attempts", "request_id")
