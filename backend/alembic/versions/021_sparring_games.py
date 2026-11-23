"""Games played against the engine opponent, and their mistakes for drilling."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import CITEXT

revision = "021_sparring_games"
down_revision = "020_master_order_covering"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sparring_games",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", CITEXT(), nullable=False),
        sa.Column("user_color", sa.Text(), nullable=False),
        sa.Column("engine_rating", sa.Integer(), nullable=False),
        sa.Column("rated", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("result", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("start_fen", sa.Text(), nullable=False),
        sa.Column("moves_uci", sa.Text(), nullable=False, server_default=""),
        sa.Column("time_control_seconds", sa.Integer(), nullable=True),
        sa.Column("played_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_sparring_games_username", "sparring_games", ["username"])
    op.create_index("ix_sparring_games_played_at", "sparring_games", ["played_at"])
    op.create_table(
        "sparring_mistakes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("game_id", sa.Integer(), sa.ForeignKey("sparring_games.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position_id", sa.Integer(), sa.ForeignKey("positions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("ply", sa.Integer(), nullable=False),
        sa.Column("user_move_uci", sa.Text(), nullable=False),
        sa.Column("user_move_san", sa.Text(), nullable=False),
        sa.Column("best_move_uci", sa.Text(), nullable=False),
        sa.Column("best_pv_uci", sa.Text(), nullable=True),
        sa.Column("reply_pv_uci", sa.Text(), nullable=True),
        sa.Column("previous_move_uci", sa.Text(), nullable=True),
        sa.Column("parent_eval_cp", sa.Integer(), nullable=False),
        sa.Column("parent_eval_mate", sa.Integer(), nullable=True),
        sa.Column("eval_drop_cp", sa.Integer(), nullable=False),
    )
    op.create_index("ix_sparring_mistakes_game_id", "sparring_mistakes", ["game_id"])
    op.create_index("ix_sparring_mistakes_position_id", "sparring_mistakes", ["position_id"])


def downgrade() -> None:
    op.drop_table("sparring_mistakes")
    op.drop_table("sparring_games")
