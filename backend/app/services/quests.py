"""Three quests a day, pointed at where the player's points go.

Duolingo's shape: a short list for today, each worth a little, and a chest for
clearing all three. The list is not a menu of everything the app can do — it
is the day's training, weighted the way the losses are. Blunder Check leads
every day, because a capture or check allowed or missed is most of what the
first player lost after the opening; the openings come second, in the course
or in Opening Rush, whichever the player prefers; the third rotates through
the rest so a week touches all of it.

Quests depend only on the player and the day, never on state that training
changes (moves due, lines left), so a quest cannot vanish because the player
did it. Each one is measured from the day's `training_events`, and every quest
can be done on any day by anyone with analysed games.
"""

from __future__ import annotations

import zlib
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class Quest:
    key: str
    title: str
    target: int
    # Where on the page the player goes to do it.
    section: str


THREATS = Quest("threats", "Spot 3 punishments in Blunder Check", 3, "threats")
OPENING = Quest("opening", "Play 10 opening moves right", 10, "openings")
ROTATION = (
    Quest("drills", "Solve 3 drills from your games", 3, "drills"),
    Quest("review", "Review one of your games", 1, "review"),
    Quest("quiz", "Get 3 Opening quiz positions right", 3, "quiz"),
    Quest("sparring", "Finish a game against the engine", 1, "play"),
)
QUEST_XP = 10
CHEST_XP = 20
# The quests' own rewards: never counted toward a quest.
QUEST_KINDS = frozenset({"quest_done", "quests_all"})


def daily_quests(username: str, day: date) -> tuple[Quest, Quest, Quest]:
    """The day's three: fixed per player and day, the third stepping through the rotation."""
    offset = zlib.crc32(username.lower().encode())
    return (THREATS, OPENING, ROTATION[(day.toordinal() + offset) % len(ROTATION)])


def _measure(key: str, events: list[tuple[str, dict]]) -> int:
    def count(kind: str) -> int:
        return sum(1 for event_kind, _ in events if event_kind == kind)

    if key == "threats":
        # Both sides of Blunder Check are the same scan: their punishment, or yours.
        return count("threat_spotted") + count("punish_found")
    if key == "opening":
        total = count("move_recalled") + count("move_early")
        for kind, detail in events:
            if kind == "line_learned":
                total += int(detail.get("moves", 1))
            elif kind == "rush":
                total += int(detail.get("score", 0))
        return total
    if key == "drills":
        return count("drill_correct")
    if key == "review":
        return count("game_reviewed")
    if key == "quiz":
        return count("quiz_correct")
    if key == "sparring":
        return count("sparring_game")
    raise ValueError(f"Unknown quest {key}")


def quest_board(username: str, day: date, events: Iterable[tuple[str, dict | None]]) -> dict:
    """Today's quests with progress, and which rewards have already been paid."""
    today = [(kind, detail or {}) for kind, detail in events]
    claimed = {detail.get("quest") for kind, detail in today if kind == "quest_done"}
    counted = [(kind, detail) for kind, detail in today if kind not in QUEST_KINDS]
    items = []
    for quest in daily_quests(username, day):
        progress = _measure(quest.key, counted)
        items.append({
            "key": quest.key,
            "title": quest.title,
            "section": quest.section,
            "target": quest.target,
            "progress": min(quest.target, progress),
            "done": progress >= quest.target,
            "claimed": quest.key in claimed,
            "xp": QUEST_XP,
        })
    return {
        "date": day.isoformat(),
        "items": items,
        "all_done": all(item["done"] for item in items),
        "chest_xp": CHEST_XP,
        "chest_opened": any(kind == "quests_all" for kind, _ in today),
    }
