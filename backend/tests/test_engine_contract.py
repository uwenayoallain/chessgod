"""The depth the crawl targets is duplicated in the frontend; keep them equal.

Every path that fills the library has to search to the same depth. The browser
crawl reads its number from TypeScript and the headless crawler from Python, so
nothing but a test stops the two from drifting — and the symptom of drift is not
a crash but a library filled at two depths, where a parent from one path and a
child from the other can never be differenced.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.engine_contract import GAME_REVIEW_DEPTH, MAX_PAIR_DEPTH_GAP, MIN_TRUSTED_DEPTH

REVIEW_DEPTH_TS = Path(__file__).parents[2] / "frontend/src/lib/analysis/review-depth.ts"


def test_frontend_and_backend_agree_on_the_review_depth() -> None:
    source = REVIEW_DEPTH_TS.read_text()
    match = re.search(r"export const GAME_REVIEW_DEPTH\s*=\s*(\d+)", source)
    assert match, f"GAME_REVIEW_DEPTH is no longer declared as expected in {REVIEW_DEPTH_TS}"

    assert int(match.group(1)) == GAME_REVIEW_DEPTH


def test_the_review_depth_clears_the_trust_floor() -> None:
    # A crawl that targeted the floor would fill the library with evaluations
    # the learning surfaces are only just willing to read, and leave no room for
    # the pairing tolerance.
    assert GAME_REVIEW_DEPTH >= MIN_TRUSTED_DEPTH + MAX_PAIR_DEPTH_GAP


def test_frontend_and_backend_cap_centipawns_at_the_same_scale() -> None:
    from app.engine_contract import DECISIVE_CP

    source = REVIEW_DEPTH_TS.read_text()
    match = re.search(r"export const DECISIVE_CP\s*=\s*(\d+)", source)
    assert match, f"DECISIVE_CP is no longer declared as expected in {REVIEW_DEPTH_TS}"
    # A move graded on the board and the same decision in the drill queue must
    # agree on how much it cost.
    assert int(match.group(1)) == DECISIVE_CP
