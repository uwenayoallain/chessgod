"""Put back the apostrophes Chess.com's ECOUrl slug drops from opening names."""
from alembic import op

revision = "023_opening_name_apostrophes"
down_revision = "022_training"
branch_labels = None
depends_on = None

# Kept in step with app/utils/opening_names.py, copied so the migration never changes.
POSSESSIVES = ("Alekhine", "Bird", "Bishop", "King", "Owen", "Petrov", "Queen")


def upgrade() -> None:
    for word in POSSESSIVES:
        op.execute(
            f"UPDATE games SET opening_name = regexp_replace(opening_name, '\\m{word}s\\M', '{word}''s', 'g') "
            f"WHERE opening_name ~ '\\m{word}s\\M'"
        )


def downgrade() -> None:
    for word in POSSESSIVES:
        op.execute(
            f"UPDATE games SET opening_name = regexp_replace(opening_name, '\\m{word}''s\\M', '{word}s', 'g') "
            f"WHERE opening_name ~ '\\m{word}''s\\M'"
        )
