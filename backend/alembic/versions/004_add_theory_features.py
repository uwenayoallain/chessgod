from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "004_add_theory_features"
down_revision = "003_add_observability_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "opening_families",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("parent_id", sa.BigInteger(), sa.ForeignKey("opening_families.id"), nullable=True),
        sa.Column("full_name", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("eco", sa.Text(), nullable=True),
        sa.Column("root_fen", sa.Text(), nullable=False),
        sa.Column("pgn", sa.Text(), nullable=False),
        sa.Column("depth", sa.Integer(), nullable=False),
        sa.Column("is_main_line", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("full_name"),
    )
    op.create_index("idx_opening_families_parent_id", "opening_families", ["parent_id"])
    op.create_index("idx_opening_families_root_fen", "opening_families", ["root_fen"])

    op.create_table(
        "repertoire_marks",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("username", sa.Text(), nullable=False),
        sa.Column("fen", sa.Text(), nullable=False),
        sa.Column("color", sa.Text(), nullable=False),
        sa.Column("intended_move_uci", sa.Text(), nullable=False),
        sa.Column("intended_move_san", sa.Text(), nullable=False),
        sa.Column("family_id", sa.BigInteger(), sa.ForeignKey("opening_families.id"), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("marked_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("username", "fen", "color"),
    )
    op.create_index("idx_repertoire_marks_username_color", "repertoire_marks", ["username", "color"])

    op.create_index(
        "idx_analysis_results_position_depth",
        "analysis_results",
        ["position_id", sa.text("depth DESC")],
    )
    op.create_index(
        "idx_gp_position_move_ply_game",
        "game_positions",
        ["position_id", "move_uci", "ply", "game_id"],
    )
    op.create_index(
        "idx_games_user_color_time_opening_played",
        "games",
        ["username", "user_color", "time_class", "eco", "opening_name", "played_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_games_user_color_time_opening_played", table_name="games")
    op.drop_index("idx_gp_position_move_ply_game", table_name="game_positions")
    op.drop_index("idx_analysis_results_position_depth", table_name="analysis_results")
    op.drop_index("idx_repertoire_marks_username_color", table_name="repertoire_marks")
    op.drop_table("repertoire_marks")
    op.drop_index("idx_opening_families_root_fen", table_name="opening_families")
    op.drop_index("idx_opening_families_parent_id", table_name="opening_families")
    op.drop_table("opening_families")
