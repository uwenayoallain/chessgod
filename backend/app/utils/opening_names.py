"""Opening names as players write them.

Chess.com's opening name reaches us through the slug of its `ECOUrl`
("Kings-Pawn-Opening"), which drops every apostrophe, so the library read
"Kings Pawn Opening" and "Queens Gambit". These are the possessives that
actually occur in the corpus; names that merely end in s (Barnes, Kadas,
Mieses, Magnus) are left alone.
"""

from __future__ import annotations

import re

POSSESSIVES = ("Alekhine", "Bird", "Bishop", "King", "Owen", "Petrov", "Queen")

_PATTERN = re.compile(r"\b(" + "|".join(POSSESSIVES) + r")s\b")


def restore_apostrophes(name: str | None) -> str | None:
    if not name:
        return name
    return _PATTERN.sub(r"\1's", name)
