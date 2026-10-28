"""Count how often a repertoire move was recalled from memory.

A move learned with the hint showing sits on the first rung; the first time it
is played from memory is what makes the line "practised", and the course
recommends that before it recommends learning yet another line. The count is
backfilled from the move_recalled / move_early events already recorded, so a
practice done before this column existed still counts.
"""
import sqlalchemy as sa
from alembic import op

revision = "024_move_recalls"
down_revision = "023_opening_name_apostrophes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "line_move_progress",
        sa.Column("recalls", sa.Integer(), nullable=False, server_default="0"),
    )
    op.execute(
        """
        UPDATE line_move_progress AS progress
        SET recalls = recalled.n
        FROM (
            SELECT username, detail->>'fen' AS fen, detail->>'uci' AS uci, count(*) AS n
            FROM training_events
            WHERE kind IN ('move_recalled', 'move_early')
            GROUP BY 1, 2, 3
        ) AS recalled
        WHERE progress.username = recalled.username
          AND progress.fen = recalled.fen
          AND progress.move_uci = recalled.uci
        """
    )


def downgrade() -> None:
    op.drop_column("line_move_progress", "recalls")
