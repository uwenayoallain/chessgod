"""Case-insensitive players, per-player game ownership and replayable imports.

Display spelling and existing game/progress IDs are preserved. Ambiguous
case-colliding unique records fail safely instead of silently losing history.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import CITEXT

revision = "019_player_import_integrity"
down_revision = "018_quarantine_foreign_evals"
branch_labels = None
depends_on = None

PLAYER_TABLES = ("games", "import_archives", "repertoire_marks", "drill_progress", "drill_attempts")


def upgrade() -> None:
    connection = op.get_bind()
    # Converting unique keys must not discard conflicting intent or receipts.
    keys = {
        "import_archives": "archive_url",
        "repertoire_marks": "fen, color",
        "drill_progress": "position_id, expected_move_uci",
        "drill_attempts": "position_id, request_id",
    }
    for table, columns in keys.items():
        extra = "WHERE request_id IS NOT NULL" if table == "drill_attempts" else ""
        collision = connection.scalar(sa.text(
            f"SELECT 1 FROM {table} {extra} GROUP BY lower(username), {columns} HAVING count(*) > 1 LIMIT 1"
        ))
        if collision:
            raise RuntimeError(f"Resolve case-colliding player records in {table} before migration; no records were removed")
    op.execute("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public")
    for table in PLAYER_TABLES:
        op.alter_column(table, "username", type_=CITEXT(), existing_type=sa.Text(), postgresql_using="username::public.citext")

    inspector = sa.inspect(connection)
    for constraint in inspector.get_unique_constraints("games"):
        if constraint["column_names"] == ["chesscom_game_url"]:
            op.drop_constraint(constraint["name"], "games", type_="unique")
    for index in inspector.get_indexes("games"):
        if index["unique"] and index["column_names"] == ["chesscom_game_url"] and not index.get("duplicates_constraint"):
            op.drop_index(index["name"], table_name="games")
    op.create_unique_constraint("uq_games_url_player", "games", ["chesscom_game_url", "username"])
    op.create_table("game_tree_sources", sa.Column("game_url", sa.Text(), primary_key=True))
    op.execute("INSERT INTO game_tree_sources (game_url) SELECT DISTINCT g.chesscom_game_url FROM games g WHERE EXISTS (SELECT 1 FROM game_positions gp WHERE gp.game_id = g.id)")
    op.add_column("import_archives", sa.Column("ownership_version", sa.Integer(), nullable=False, server_default="0"))
    op.alter_column("import_archives", "ownership_version", server_default="2")

    op.create_table("import_jobs",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("username", CITEXT(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.create_index("ix_import_jobs_username", "import_jobs", ["username"])
    op.create_index("uq_import_jobs_running_player", "import_jobs", ["username"], unique=True, postgresql_where=sa.text("status = 'running'"))
    op.create_table("import_job_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("job_id", sa.Text(), sa.ForeignKey("import_jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False))
    op.create_index("ix_import_job_events_job_id", "import_job_events", ["job_id"])


def downgrade() -> None:
    # Refuse destructive rollback once both players own a shared game.
    if op.get_bind().scalar(sa.text("SELECT 1 FROM games GROUP BY chesscom_game_url HAVING count(*) > 1 LIMIT 1")):
        raise RuntimeError("Cannot restore global URL uniqueness without discarding player-owned games")
    op.drop_table("import_job_events")
    op.drop_table("import_jobs")
    op.drop_column("import_archives", "ownership_version")
    op.drop_table("game_tree_sources")
    op.drop_constraint("uq_games_url_player", "games", type_="unique")
    op.create_unique_constraint("games_chesscom_game_url_key", "games", ["chesscom_game_url"])
    for table in PLAYER_TABLES:
        op.alter_column(table, "username", type_=sa.Text(), existing_type=CITEXT(), postgresql_using="username::text")
