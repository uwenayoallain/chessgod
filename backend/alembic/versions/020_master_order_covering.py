"""Cover the master-move ordering index and keep position_moves vacuumed.

The Theory Deviations query (`_MISTAKES_SQL`) ranks every position's top three
master moves. That read was ~500ms of a ~1.1s query: the partial index found the
~39k rows carrying master data in 5ms, then fetched each one from a 2.6M-row
heap for `move_uci`. Including `move_uci` makes it an index-only scan, but only
where the visibility map is current — and on this table it never was. The
default autovacuum threshold is 20% of the table (~520k dead rows) while a master
sync rewrites ~40k, so the table was never vacuumed and every "index-only" read
still went to the heap. Measured: 497ms as it was, 170ms after one VACUUM, 20ms
with the covering index as well.
"""
from alembic import op
import sqlalchemy as sa

revision = "020_master_order_covering"
down_revision = "019_player_import_integrity"
branch_labels = None
depends_on = None

_ORDER = ["from_position_id", sa.text("master_game_count DESC"), sa.text("game_count DESC")]


def upgrade() -> None:
    op.drop_index("idx_pm_master_order", table_name="position_moves")
    # Partial, so it holds only the ~39k rows with master data: quick to build.
    op.create_index(
        "idx_pm_master_order",
        "position_moves",
        _ORDER,
        postgresql_include=["move_uci"],
        postgresql_where=sa.text("master_game_count IS NOT NULL"),
    )
    # About 26k changed rows rather than ~520k, so a master sync is followed
    # by a vacuum and the index-only scan stays index-only.
    op.execute(
        "ALTER TABLE position_moves SET ("
        "autovacuum_vacuum_scale_factor = 0.01, autovacuum_analyze_scale_factor = 0.01)"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE position_moves RESET ("
        "autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor)"
    )
    op.drop_index("idx_pm_master_order", table_name="position_moves")
    op.create_index(
        "idx_pm_master_order",
        "position_moves",
        _ORDER,
        postgresql_where=sa.text("master_game_count IS NOT NULL"),
    )
