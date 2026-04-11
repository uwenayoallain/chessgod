from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "games",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("chesscom_game_url", sa.Text(), nullable=False),
        sa.Column("chesscom_game_id", sa.Text(), nullable=True),
        sa.Column("username", sa.Text(), nullable=False),
        sa.Column("white_username", sa.Text(), nullable=False),
        sa.Column("black_username", sa.Text(), nullable=False),
        sa.Column("user_color", sa.Text(), nullable=False),
        sa.Column("result", sa.Text(), nullable=False),
        sa.Column("user_result", sa.Text(), nullable=False),
        sa.Column("time_class", sa.Text(), nullable=False),
        sa.Column("time_control", sa.Text(), nullable=True),
        sa.Column("white_rating", sa.Integer(), nullable=True),
        sa.Column("black_rating", sa.Integer(), nullable=True),
        sa.Column("pgn", sa.Text(), nullable=False),
        sa.Column("eco", sa.Text(), nullable=True),
        sa.Column("opening_name", sa.Text(), nullable=True),
        sa.Column("played_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("num_moves", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("chesscom_game_url"),
    )
    op.create_index("idx_games_username", "games", ["username"])
    op.create_index("idx_games_played_at", "games", ["username", "played_at"])
    op.create_index("idx_games_time_class", "games", ["username", "time_class"])
    op.create_index("idx_games_user_result", "games", ["username", "user_result"])

    op.create_table(
        "positions",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("fen", sa.Text(), nullable=False),
        sa.Column("total_games", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("white_wins", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("draws", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("black_wins", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("master_total", sa.Integer(), nullable=True),
        sa.Column("master_white", sa.Integer(), nullable=True),
        sa.Column("master_draws", sa.Integer(), nullable=True),
        sa.Column("master_black", sa.Integer(), nullable=True),
        sa.Column("master_eco", sa.Text(), nullable=True),
        sa.Column("master_opening_name", sa.Text(), nullable=True),
        sa.Column("master_fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("fen"),
    )
    op.create_index("idx_positions_fen_hash", "positions", ["fen"], postgresql_using="hash")

    op.create_table(
        "position_moves",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("from_position_id", sa.BigInteger(), sa.ForeignKey("positions.id"), nullable=False),
        sa.Column("to_position_id", sa.BigInteger(), sa.ForeignKey("positions.id"), nullable=False),
        sa.Column("move_san", sa.Text(), nullable=False),
        sa.Column("move_uci", sa.Text(), nullable=False),
        sa.Column("move_number", sa.Integer(), nullable=False),
        sa.Column("is_white_move", sa.Boolean(), nullable=False),
        sa.Column("game_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("white_wins", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("draws", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("black_wins", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("avg_opponent_rating", sa.Float(), nullable=True),
        sa.Column("master_game_count", sa.Integer(), nullable=True),
        sa.Column("master_white_wins", sa.Integer(), nullable=True),
        sa.Column("master_draws", sa.Integer(), nullable=True),
        sa.Column("master_black_wins", sa.Integer(), nullable=True),
        sa.Column("master_fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("from_position_id", "move_uci"),
    )
    op.create_index("idx_pm_from", "position_moves", ["from_position_id"])
    op.create_index("idx_pm_to", "position_moves", ["to_position_id"])
    op.create_index("idx_pm_game_count", "position_moves", ["from_position_id", "game_count"])

    op.create_table(
        "game_positions",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("game_id", sa.BigInteger(), sa.ForeignKey("games.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position_id", sa.BigInteger(), sa.ForeignKey("positions.id"), nullable=False),
        sa.Column("ply", sa.Integer(), nullable=False),
        sa.Column("move_san", sa.Text(), nullable=True),
        sa.Column("move_uci", sa.Text(), nullable=True),
    )
    op.create_index("idx_gp_game", "game_positions", ["game_id"])
    op.create_index("idx_gp_position", "game_positions", ["position_id"])
    op.create_index("idx_gp_game_ply", "game_positions", ["game_id", "ply"], unique=True)

    op.create_table(
        "import_archives",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("username", sa.Text(), nullable=False),
        sa.Column("archive_url", sa.Text(), nullable=False),
        sa.Column("archive_month", sa.Text(), nullable=False),
        sa.Column("games_in_archive", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("fetched_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("username", "archive_url"),
    )
    op.create_index("idx_import_archives_username", "import_archives", ["username"])
    op.create_index("idx_import_archives_archive_month", "import_archives", ["archive_month"])

    op.create_table(
        "analysis_results",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("position_id", sa.BigInteger(), sa.ForeignKey("positions.id"), nullable=False),
        sa.Column("engine", sa.Text(), nullable=False, server_default="stockfish"),
        sa.Column("engine_version", sa.Text(), nullable=True),
        sa.Column("depth", sa.Integer(), nullable=False),
        sa.Column("eval_cp", sa.Integer(), nullable=True),
        sa.Column("eval_mate", sa.Integer(), nullable=True),
        sa.Column("best_move_uci", sa.Text(), nullable=False),
        sa.Column("best_move_san", sa.Text(), nullable=False),
        sa.Column("pv_uci", sa.Text(), nullable=True),
        sa.Column("pv_san", sa.Text(), nullable=True),
        sa.Column("multipv_rank", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("analyzed_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("position_id", "engine", "depth", "multipv_rank"),
    )
    op.create_index("idx_ar_position", "analysis_results", ["position_id"])


def downgrade() -> None:
    op.drop_index("idx_ar_position", table_name="analysis_results")
    op.drop_table("analysis_results")
    op.drop_index("idx_import_archives_archive_month", table_name="import_archives")
    op.drop_index("idx_import_archives_username", table_name="import_archives")
    op.drop_table("import_archives")
    op.drop_index("idx_gp_game_ply", table_name="game_positions")
    op.drop_index("idx_gp_position", table_name="game_positions")
    op.drop_index("idx_gp_game", table_name="game_positions")
    op.drop_table("game_positions")
    op.drop_index("idx_pm_game_count", table_name="position_moves")
    op.drop_index("idx_pm_to", table_name="position_moves")
    op.drop_index("idx_pm_from", table_name="position_moves")
    op.drop_table("position_moves")
    op.drop_index("idx_positions_fen_hash", table_name="positions")
    op.drop_table("positions")
    op.drop_index("idx_games_user_result", table_name="games")
    op.drop_index("idx_games_time_class", table_name="games")
    op.drop_index("idx_games_played_at", table_name="games")
    op.drop_index("idx_games_username", table_name="games")
    op.drop_table("games")
