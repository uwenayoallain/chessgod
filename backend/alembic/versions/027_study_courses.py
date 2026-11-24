"""Store imported study courses and their playable chapters."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT

revision = "027_study_courses"
down_revision = "026_drop_unused_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    big_id = sa.BigInteger().with_variant(sa.Integer(), "sqlite")
    username = sa.Text(collation="NOCASE").with_variant(CITEXT(), "postgresql")
    op.create_table(
        "study_courses",
        sa.Column("id", big_id, primary_key=True),
        sa.Column("username", username, nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("color", sa.Text(), nullable=False),
        sa.Column("source_type", sa.Text(), nullable=False),
        sa.Column("source_ref", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_study_courses_username", "study_courses", ["username"])
    op.create_table(
        "study_chapters",
        sa.Column("id", big_id, primary_key=True),
        sa.Column(
            "course_id", big_id, sa.ForeignKey("study_courses.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("start_fen", sa.Text(), nullable=False),
        sa.Column("pgn", sa.Text(), nullable=False),
        sa.Column("lines_json", sa.JSON(), nullable=False),
    )
    op.create_index("ix_study_chapters_course_id", "study_chapters", ["course_id"])


def downgrade() -> None:
    op.drop_table("study_chapters")
    op.drop_table("study_courses")
