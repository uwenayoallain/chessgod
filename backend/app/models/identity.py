"""Case-insensitive player identifiers, preserving existing display spelling."""
from sqlalchemy import Text
from sqlalchemy.dialects.postgresql import CITEXT

Username = Text(collation="NOCASE").with_variant(CITEXT(), "postgresql")
