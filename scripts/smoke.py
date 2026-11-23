"""Hit every workspace surface's endpoint against the running stack.

A page-per-chip workspace means each surface fetches on first view, so one
broken endpoint is a page that quietly fails for whoever opens it. This asks
all of them, cold then warm, and exits non-zero if any fails — the check to
run after a deploy or a restart, when the suites are green but the stack is
the question.

    make smoke USERNAME=name
"""

from __future__ import annotations

import os
import sys
import time
import urllib.request

API = os.environ.get("SMOKE_API", "http://localhost:18000")


def endpoints(username: str) -> list[tuple[str, str]]:
    return [
        ("Today/profile", f"/api/training/profile?username={username}"),
        ("Blunder Check", f"/api/training/threats?username={username}&seed=1"),
        ("Rush", f"/api/training/rush?username={username}"),
        ("Repertoire (black)", f"/api/training/repertoire?username={username}&color=black"),
        ("Repertoire (white)", f"/api/training/repertoire?username={username}&color=white"),
        ("Drills/plan", f"/api/improvement/plan?username={username}"),
        ("Quiz", f"/api/theory/opening-quiz?username={username}&color=both&limit=12"),
        ("Your week", f"/api/training/week?username={username}"),
        ("Improving?", f"/api/training/progress?username={username}"),
        ("Points", f"/api/improvement/where-points-go?username={username}&color=both"),
        ("Clock", f"/api/training/clock?username={username}"),
        ("Habits", f"/api/training/habits?username={username}"),
        ("Punish it", f"/api/training/punish?username={username}"),
        ("Rating goal", f"/api/training/rating-goal?username={username}"),
        ("Mistakes", f"/api/theory/mistakes?username={username}&color=both"),
        ("Openings/families", f"/api/theory/families?username={username}&color=both"),
        ("Deviations", "/api/theory/deviations?color=white"),
        ("Stats/summary", f"/api/import/{username}/summary"),
        ("Engine activity", "/api/analysis/activity"),
        ("Health", "/api/health"),
    ]


def main() -> int:
    username = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("USERNAME", "")
    if not username:
        print("usage: smoke.py <username>")
        return 2
    failures = 0
    for name, path in endpoints(username):
        url = API + path
        try:
            started = time.time()
            urllib.request.urlopen(url, timeout=120).read()
            cold = time.time()
            urllib.request.urlopen(url, timeout=120).read()
            warm = time.time()
            print(f"{name:20s} ok   cold {1000 * (cold - started):6.0f}ms  warm {1000 * (warm - cold):5.0f}ms")
        except Exception as error:  # noqa: BLE001 - a smoke check reports, never raises
            failures += 1
            print(f"{name:20s} FAIL {error}")
    if failures:
        print(f"{failures} surface(s) failing")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
