"""Move evaluations from other engines out of the table the planner reads.

Every learning query filters ``engine = 'stockfish-19' AND engine_version =
'19'``, so a row from any other engine can never grade a decision. Those rows
still sat in ``analysis_results``, where they were indistinguishable from
trusted ones except by a string, and where they made the table look far fuller
than the planner could see: on the first real corpus 8,840 of 9,049 rows (97.7%)
were unreadable, which made a 3.9% coverage number read as "nothing has been
analyzed yet".

Two kinds of row are moved, and nothing is deleted:

* Lichess cloud evaluations go to ``cloud_evaluations``. They were always
  written but never read back by anything except their own module, and they are
  explicitly not a trusted learning source — a cache of somebody else's search,
  at a depth we did not choose, which must never be differenced against ours.
* Anything else — the Stockfish 17.1 rows left by the removed server-side
  analysis worker, and rows whose build was never recorded — goes to
  ``legacy_analysis_results``. Archiving rather than dropping keeps the decision
  reversible: if those engines are ever trusted again the evidence is still here.

A CHECK constraint then makes the separation structural, so a future writer
cannot reintroduce the ambiguity by passing a different engine name.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "018_quarantine_foreign_evals"
down_revision = "017_analysis_depth_rows"
branch_labels = None
depends_on = None

_CONTRACT = "engine = 'stockfish-19' AND engine_version = '19'"
_COLUMNS = """id, position_id, engine, engine_version, depth, eval_cp, eval_mate,
              best_move_uci, best_move_san, pv_uci, pv_san, multipv_rank, analyzed_at"""


def _archive_table(name: str) -> None:
    op.create_table(
        name,
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("position_id", sa.Integer(), nullable=False, index=True),
        sa.Column("engine", sa.Text(), nullable=False),
        sa.Column("engine_version", sa.Text(), nullable=True),
        sa.Column("depth", sa.Integer(), nullable=False),
        sa.Column("eval_cp", sa.Integer(), nullable=True),
        sa.Column("eval_mate", sa.Integer(), nullable=True),
        sa.Column("best_move_uci", sa.Text(), nullable=False),
        sa.Column("best_move_san", sa.Text(), nullable=False),
        sa.Column("pv_uci", sa.Text(), nullable=True),
        sa.Column("pv_san", sa.Text(), nullable=True),
        sa.Column("multipv_rank", sa.Integer(), nullable=False),
        sa.Column("analyzed_at", sa.DateTime(timezone=True), nullable=True),
    )


def upgrade() -> None:
    _archive_table("cloud_evaluations")
    _archive_table("legacy_analysis_results")

    op.execute(
        f"INSERT INTO cloud_evaluations ({_COLUMNS}) "
        f"SELECT {_COLUMNS} FROM analysis_results WHERE engine = 'lichess-cloud'"
    )
    op.execute(
        f"INSERT INTO legacy_analysis_results ({_COLUMNS}) "
        f"SELECT {_COLUMNS} FROM analysis_results "
        f"WHERE engine <> 'lichess-cloud' AND NOT ({_CONTRACT})"
    )
    op.execute(f"DELETE FROM analysis_results WHERE NOT ({_CONTRACT})")
    op.create_check_constraint(
        "ck_analysis_results_engine_contract", "analysis_results", _CONTRACT
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_analysis_results_engine_contract", "analysis_results", type_="check"
    )
    for table in ("cloud_evaluations", "legacy_analysis_results"):
        op.execute(
            f"INSERT INTO analysis_results ({_COLUMNS}) SELECT {_COLUMNS} FROM {table}"
        )
        op.drop_table(table)
