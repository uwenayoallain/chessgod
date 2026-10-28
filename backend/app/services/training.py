"""XP, levels, streaks and achievements, and the repertoire's move memory.

Built after Chessable's MoveTrainer and Chessly: each repertoire move has its
own review timer on a fixed ladder (4 hours, a day, three days, a week, two
weeks, a month, three months, six months). A recalled move climbs one rung,
a missed one falls back to the first, and a move reviewed before it is due
earns a little XP but does not climb — otherwise the ladder measures how often
the button was pressed, not what the player remembers.

Everything a player sees about their training — XP, level, streak, badges — is
computed from the append-only `training_events` log, so none of it can drift
from what they actually did.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.drill_progress import DrillProgress
from app.models.training import LineMoveProgress, TrainingEvent
from app.services import quests

LEVEL_INTERVALS = {
    1: timedelta(hours=4),
    2: timedelta(days=1),
    3: timedelta(days=3),
    4: timedelta(days=7),
    5: timedelta(days=14),
    6: timedelta(days=30),
    7: timedelta(days=90),
    8: timedelta(days=180),
}
MAX_MOVE_LEVEL = 8
# A move this far up the ladder has survived a week: the line is known.
MASTERED_LEVEL = 4

XP = {
    "drill_correct": 10,
    "drill_wrong": 2,
    "line_learned": 15,
    "move_recalled": 3,
    "move_early": 1,
    "move_missed": 1,
    "line_perfect": 10,
    "quiz_correct": 4,
    "quiz_answer": 1,
    "game_reviewed": 15,
    "sparring_game": 15,
    # Won or drawn from a line's end against the engine, or merely fought.
    "boss_defeated": 30,
    "boss_fought": 5,
    # Opening Rush pays by score: 2 XP a correct answer plus 5 for playing, capped.
    "rush": 0,
    # Blunder Check: the opponent's punishment of the player's own mistake, found.
    "threat_spotted": 5,
    "threat_missed": 1,
    # Punish it: the move that keeps an opponent's mistake, found (services/threats.py).
    "punish_found": 5,
    "punish_missed": 1,
    # Retrying the player's own mistakes in a reviewed game, judged against the engine.
    "retry_found": 5,
    "retry_missed": 1,
    # Daily quests (services/quests.py): each one done, and all three.
    "quest_done": quests.QUEST_XP,
    "quests_all": quests.CHEST_XP,
    # A weekly challenge met in the player's real games (services/challenges.py).
    "challenge_done": 40,
}
RUSH_XP_PER_ANSWER = 2
RUSH_XP_BONUS = 5
RUSH_XP_CAP = 60
# One streak freeze for every 250 XP earned, at most two held. A day that misses
# the goal inside a streak spends one instead of ending the streak.
FREEZE_EVERY_XP = 250
MAX_FREEZES = 2
# What a client may report by itself. Everything else is awarded by the server
# when it records the thing that earned it.
CLIENT_EVENTS = {"quiz_correct", "quiz_answer", "game_reviewed", "retry_found", "retry_missed"}
DAILY_GOALS = (20, 50, 100)
DEFAULT_DAILY_GOAL = 50

TITLES = ((18, "King"), (12, "Queen"), (8, "Rook"), (5, "Bishop"), (3, "Knight"), (1, "Pawn"))


@dataclass(frozen=True)
class Achievement:
    key: str
    title: str
    description: str
    target: int


ACHIEVEMENTS = (
    Achievement("first_drill", "First solve", "Solve your first drill from your own games.", 1),
    Achievement("drills_50", "Sharp eyes", "Solve 50 drills.", 50),
    Achievement("drills_250", "Tactician", "Solve 250 drills.", 250),
    Achievement("first_line", "Opening student", "Learn your first repertoire line.", 1),
    Achievement("lines_10", "Repertoire builder", "Learn 10 repertoire lines.", 10),
    Achievement("leak_plugged", "Leak plugged", "Play a line with a changed move perfectly.", 1),
    Achievement("trap_setter", "Trap setter", "Play a line that punishes a trap perfectly.", 1),
    Achievement("recall_100", "Memory palace", "Recall 100 repertoire moves when they were due.", 100),
    Achievement("streak_3", "Warming up", "Meet your daily goal 3 days in a row.", 3),
    Achievement("streak_7", "On fire", "Meet your daily goal 7 days in a row.", 7),
    Achievement("streak_30", "Unstoppable", "Meet your daily goal 30 days in a row.", 30),
    Achievement("sparring_5", "Sparring partner", "Finish 5 games against the engine.", 5),
    Achievement("xp_1000", "Grinder", "Earn 1,000 XP.", 1000),
    Achievement("rush_10", "Quick draw", "Score 10 in an Opening Rush.", 10),
    Achievement("rush_25", "Lightning", "Score 25 in an Opening Rush.", 25),
    Achievement("boss_slayer", "Boss slayer", "Beat the engine from the end of one of your lines.", 1),
    Achievement("hawk_eye", "Hawk eye", "Spot 50 punishments in Blunder Check.", 50),
    Achievement("rival_beaten", "Better than last week", "Finish a week with more XP than the week before.", 1),
    Achievement("quest_master", "Quest master", "Clear all three daily quests on 7 days.", 7),
    Achievement("second_chance", "Second chance", "Find the better move for 25 of your own mistakes.", 25),
    Achievement("board_challenge", "Took it to the board",
                "Finish a weekly challenge in your real games.", 1),
)


def level_threshold(level: int) -> int:
    """Cumulative XP needed to reach `level`: 0, 100, 300, 600, 1000, ..."""
    return 50 * level * (level - 1)


def level_for(xp: int) -> int:
    level = 1
    while level_threshold(level + 1) <= xp:
        level += 1
    return level


def title_for(level: int) -> str:
    return next(title for floor, title in TITLES if level >= floor)


def next_level(level: int, *, correct: bool, due: bool) -> int:
    """The move's rung after one recall attempt."""
    if not correct:
        return 1
    if not due:
        return max(level, 1)
    return min(MAX_MOVE_LEVEL, max(level, 1) + 1)


async def award(
    session: AsyncSession,
    username: str,
    kind: str,
    *,
    xp: int | None = None,
    detail: dict | None = None,
    request_id: str | None = None,
) -> int:
    """Record one piece of training. Returns the XP granted (0 on a replay)."""
    amount = XP[kind] if xp is None else xp
    if request_id is not None:
        exists = (
            await session.execute(
                select(TrainingEvent.id).where(
                    TrainingEvent.username == username, TrainingEvent.request_id == request_id
                )
            )
        ).scalar_one_or_none()
        if exists is not None:
            return 0
    try:
        async with session.begin_nested():
            session.add(TrainingEvent(
                username=username, kind=kind, xp=amount, detail=detail, request_id=request_id,
            ))
    except IntegrityError:
        return 0
    return amount


def _zone(tz: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(tz or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


@dataclass(frozen=True)
class Streaks:
    current: int
    best: int
    # The day each run length was first reached, for dating achievements.
    reached: dict[int, date]
    # Missed days a freeze kept a streak alive through.
    frozen: frozenset[date]
    freezes: int


def compute_streaks(days: dict[date, int], goal: int, today: date) -> Streaks:
    """Runs of days meeting the goal, with freezes earned by XP and spent on misses.

    Today is still open: until midnight a run ending yesterday stands, and
    today is neither met nor missed.
    """
    if not days:
        return Streaks(0, 0, {}, frozenset(), 0)
    run = best = freezes = cumulative = 0
    next_freeze = FREEZE_EVERY_XP
    reached: dict[int, date] = {}
    frozen: set[date] = set()
    day = min(days)
    while day <= today:
        xp = days.get(day, 0)
        cumulative += xp
        while cumulative >= next_freeze:
            freezes = min(MAX_FREEZES, freezes + 1)
            next_freeze += FREEZE_EVERY_XP
        if xp >= goal:
            run += 1
            best = max(best, run)
            reached.setdefault(run, day)
        elif day == today:
            pass
        elif run > 0 and freezes > 0:
            freezes -= 1
            frozen.add(day)
        else:
            run = 0
        day += timedelta(days=1)
    return Streaks(run, best, reached, frozenset(frozen), freezes)


def _week_start(day: date) -> date:
    return day - timedelta(days=day.weekday())


def rival(days: dict[date, int], today: date) -> dict:
    """This week so far against last week at the same point, and last week in full."""
    monday = _week_start(today)
    elapsed = (today - monday).days
    last_monday = monday - timedelta(days=7)

    def total(first: date, count: int) -> int:
        return sum(days.get(first + timedelta(days=offset), 0) for offset in range(count))

    return {
        "this_week": total(monday, elapsed + 1),
        "last_week_so_far": total(last_monday, elapsed + 1),
        "last_week": total(last_monday, 7),
    }


def _rival_beaten(days: dict[date, int], today: date) -> date | None:
    """The first Sunday that closed a week with more XP than the week before it."""
    if not days:
        return None
    monday = _week_start(min(days)) + timedelta(days=7)
    while monday + timedelta(days=6) < today:
        this = sum(days.get(monday + timedelta(days=offset), 0) for offset in range(7))
        last = sum(days.get(monday - timedelta(days=7 - offset), 0) for offset in range(7))
        if last > 0 and this > last:
            return monday + timedelta(days=6)
        monday += timedelta(days=7)
    return None


async def profile(
    session: AsyncSession, username: str, *, tz: str | None = None, goal: int = DEFAULT_DAILY_GOAL,
    now: datetime | None = None,
) -> dict:
    now = now or datetime.now(UTC)
    zone = _zone(tz)
    goal = goal if goal in DAILY_GOALS else DEFAULT_DAILY_GOAL
    events = (
        await session.execute(
            select(TrainingEvent.kind, TrainingEvent.xp, TrainingEvent.detail, TrainingEvent.created_at)
            .where(TrainingEvent.username == username)
            .order_by(TrainingEvent.created_at, TrainingEvent.id)
        )
    ).all()
    today = now.astimezone(zone).date()
    days: defaultdict[date, int] = defaultdict(int)
    counts: Counter[str] = Counter()
    unlocked_at: dict[str, datetime] = {}
    total = 0
    rush_best = 0
    today_events: list[tuple[str, dict | None]] = []

    def unlock(key: str, when: datetime) -> None:
        unlocked_at.setdefault(key, when)

    for kind, xp, detail, created_at in events:
        when = created_at if created_at.tzinfo else created_at.replace(tzinfo=UTC)
        day = when.astimezone(zone).date()
        days[day] += xp
        if day == today:
            today_events.append((kind, detail))
        total += xp
        counts[kind] += 1
        detail = detail or {}
        if kind == "line_perfect" and detail.get("changes"):
            counts["leak_plugged"] += 1
        if kind == "line_perfect" and detail.get("traps"):
            counts["trap_setter"] += 1
        if kind == "rush":
            rush_best = max(rush_best, int(detail.get("score", 0)))
            for key, target in (("rush_10", 10), ("rush_25", 25)):
                if rush_best >= target:
                    unlock(key, when)
        for achievement, metric in (
            ("first_drill", "drill_correct"), ("drills_50", "drill_correct"),
            ("drills_250", "drill_correct"), ("first_line", "line_learned"),
            ("lines_10", "line_learned"), ("leak_plugged", "leak_plugged"),
            ("trap_setter", "trap_setter"), ("recall_100", "move_recalled"),
            ("sparring_5", "sparring_game"), ("boss_slayer", "boss_defeated"),
            ("hawk_eye", "threat_spotted"), ("quest_master", "quests_all"),
            ("board_challenge", "challenge_done"), ("second_chance", "retry_found"),
        ):
            target = next(a.target for a in ACHIEVEMENTS if a.key == achievement)
            if counts[metric] >= target:
                unlock(achievement, when)
        if total >= 1000:
            unlock("xp_1000", when)

    streaks = compute_streaks(days, goal, today)
    for key, length in (("streak_3", 3), ("streak_7", 7), ("streak_30", 30)):
        if length in streaks.reached:
            day = streaks.reached[length]
            unlock(key, datetime.combine(day, datetime.min.time(), tzinfo=zone))
    beaten = _rival_beaten(days, today)
    if beaten is not None:
        unlock("rival_beaten", datetime.combine(beaten, datetime.min.time(), tzinfo=zone))

    progress_value = {
        "first_drill": counts["drill_correct"], "drills_50": counts["drill_correct"],
        "drills_250": counts["drill_correct"], "first_line": counts["line_learned"],
        "lines_10": counts["line_learned"], "leak_plugged": counts["leak_plugged"],
        "trap_setter": counts["trap_setter"], "recall_100": counts["move_recalled"],
        "streak_3": streaks.best, "streak_7": streaks.best, "streak_30": streaks.best,
        "sparring_5": counts["sparring_game"], "xp_1000": total,
        "rush_10": rush_best, "rush_25": rush_best,
        "boss_slayer": counts["boss_defeated"], "rival_beaten": int(beaten is not None),
        "hawk_eye": counts["threat_spotted"], "quest_master": counts["quests_all"],
        "board_challenge": counts["challenge_done"], "second_chance": counts["retry_found"],
    }
    level = level_for(total)
    due_moves = (
        await session.execute(
            select(func.count()).select_from(LineMoveProgress).where(
                LineMoveProgress.username == username,
                LineMoveProgress.level >= 1,
                LineMoveProgress.due_at <= now,
            )
        )
    ).scalar_one()
    due_drills = (
        await session.execute(
            select(func.count()).select_from(DrillProgress).where(
                DrillProgress.username == username, DrillProgress.due_at <= now,
            )
        )
    ).scalar_one()
    today_xp = days.get(today, 0)
    return {
        "username": username,
        "xp": total,
        "level": level,
        "title": title_for(level),
        "level_floor_xp": level_threshold(level),
        "next_level_xp": level_threshold(level + 1),
        "daily_goal": goal,
        "today_xp": today_xp,
        "goal_met_today": today_xp >= goal,
        "streak": streaks.current,
        "best_streak": streaks.best,
        "freezes": streaks.freezes,
        "freeze_every_xp": FREEZE_EVERY_XP,
        "week": [
            {
                "date": (today - timedelta(days=offset)).isoformat(),
                "xp": days.get(today - timedelta(days=offset), 0),
                "frozen": (today - timedelta(days=offset)) in streaks.frozen,
            }
            for offset in range(6, -1, -1)
        ],
        "rival": rival(days, today),
        "rush_best": rush_best,
        "threats_spotted": counts["threat_spotted"],
        "threats_seen": counts["threat_spotted"] + counts["threat_missed"],
        "punish_found": counts["punish_found"],
        "punish_seen": counts["punish_found"] + counts["punish_missed"],
        "due_repertoire_moves": int(due_moves),
        "due_drills": int(due_drills),
        "quests": quests.quest_board(username, today, today_events),
        "achievements": [
            {
                "key": a.key,
                "title": a.title,
                "description": a.description,
                "target": a.target,
                "progress": min(a.target, progress_value[a.key]),
                "unlocked_at": unlocked_at[a.key].isoformat() if a.key in unlocked_at else None,
            }
            for a in ACHIEVEMENTS
        ],
    }


async def load_move_progress(session: AsyncSession, username: str) -> dict[tuple[str, str], LineMoveProgress]:
    rows = (
        await session.execute(select(LineMoveProgress).where(LineMoveProgress.username == username))
    ).scalars().all()
    return {(row.fen, row.move_uci): row for row in rows}


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def annotate_repertoire(repertoire: dict, progress: dict[tuple[str, str], LineMoveProgress],
                        *, now: datetime | None = None) -> dict:
    """The served repertoire with the player's memory of each move and line."""
    now = now or datetime.now(UTC)
    for line in repertoire["lines"]:
        yours = [step for step in line["moves"] if step["side"] == "you"]
        levels = []
        due = 0
        recalled = 0
        for step in yours:
            row = progress.get((step["fen"], step["uci"]))
            level = row.level if row else None
            is_due = bool(row and row.level >= 1 and _aware(row.due_at) <= now)
            step["level"] = level
            step["due"] = is_due
            step["due_at"] = _aware(row.due_at).isoformat() if row else None
            step["recalled"] = bool(row and (getattr(row, "recalls", 0) or 0) > 0)
            levels.append(level)
            due += int(is_due)
            recalled += int(step["recalled"])
        known = sum(1 for level in levels if level is not None and level >= 1)
        line["your_moves"] = len(yours)
        line["known_moves"] = known
        line["due_moves"] = due
        line["recalled_moves"] = recalled
        # Learned is not practised: a move taught with the hint showing has never
        # been played from memory. Until every move has, the course offers this
        # line to practise before it offers another line to learn.
        line["practised"] = known == len(yours) and recalled == len(yours)
        # A line is new until every one of its moves has been taught. Lines share
        # moves (every Black line starts 1...e5), so counting "any move known"
        # turned lines never shown into ones to practise from memory.
        line["new_moves"] = len(yours) - known
        if known < len(yours):
            line["status"] = "new"
        elif due:
            line["status"] = "due"
        elif all(level >= MASTERED_LEVEL for level in levels):
            line["status"] = "mastered"
        else:
            line["status"] = "learning"
    return repertoire


async def record_line_review(
    session: AsyncSession,
    *,
    username: str,
    color: str,
    line: dict,
    mode: str,
    played: dict[str, str],
    request_id: str | None,
    now: datetime | None = None,
) -> dict:
    """Score one pass through a line and move each of the player's moves on the ladder.

    `played` maps each of the player's positions in the line to the first move
    they made there. Correctness is decided here, against the line, never
    taken from the client.
    """
    now = now or datetime.now(UTC)
    progress = await load_move_progress(session, username)
    yours = [step for step in line["moves"] if step["side"] == "you"]
    results = []
    xp = 0
    misses = 0
    any_due = False
    for step in yours:
        answer = played.get(step["fen"])
        correct = answer == step["uci"]
        misses += int(not correct)
        row = progress.get((step["fen"], step["uci"]))
        if row is None:
            row = LineMoveProgress(
                username=username, color=color, fen=step["fen"], move_uci=step["uci"],
                level=0, reviews=0, recalls=0, lapses=0, due_at=now,
            )
            session.add(row)
            progress[(step["fen"], step["uci"])] = row
        due = row.level < 1 or _aware(row.due_at) <= now
        any_due = any_due or due
        if mode == "learn":
            # Played with the hint showing: introduced, first rung, nothing to recall yet.
            row.level = max(row.level or 0, 1) if correct else max(row.level or 0, 0)
            row.due_at = now + LEVEL_INTERVALS[1] if (row.level or 0) >= 1 else now
        else:
            before = row.level or 0
            row.level = next_level(before, correct=correct, due=due)
            if not correct:
                row.lapses = (row.lapses or 0) + 1
            else:
                row.recalls = (row.recalls or 0) + 1
            if correct and not due:
                xp_kind = "move_early"
            else:
                xp_kind = "move_recalled" if correct else "move_missed"
            if correct and due or not correct or before != row.level:
                row.due_at = now + LEVEL_INTERVALS[row.level]
            xp += await award(session, username, xp_kind, detail={"fen": step["fen"], "uci": step["uci"]},
                              request_id=f"{request_id}:{step['fen']}" if request_id else None)
        row.reviews = (row.reviews or 0) + 1
        row.last_reviewed_at = now
        results.append({"fen": step["fen"], "uci": step["uci"], "correct": correct,
                        "level": row.level, "due_at": _aware(row.due_at).isoformat()})

    detail = {
        "line_id": line["id"], "changes": line.get("changes", 0), "traps": line.get("traps", 0),
        "moves": len(yours),
    }
    if mode == "learn" and not misses:
        xp += await award(session, username, "line_learned", detail=detail,
                          request_id=f"learned:{color}:{line['id']}")
    # A perfect pass pays only when it was a real review: replaying a line that
    # nothing in is due yet would otherwise be a way to farm XP.
    if mode == "practice" and not misses and any_due:
        xp += await award(session, username, "line_perfect", detail=detail,
                          request_id=f"{request_id}:perfect" if request_id else None)
    return {"results": results, "misses": misses, "xp_gained": xp}


async def settle_quests(
    session: AsyncSession, username: str, *, tz: str | None = None, now: datetime | None = None,
) -> int:
    """Pay today's finished quests, and the chest once all three are done.

    Idempotent: each reward carries the day in its request id, so calling this
    after every piece of training pays each quest once.
    """
    now = now or datetime.now(UTC)
    zone = _zone(tz)
    today = now.astimezone(zone).date()
    # A coarse cut in SQL, the exact local day in Python: no timezone arithmetic in the query.
    rows = (
        await session.execute(
            select(TrainingEvent.kind, TrainingEvent.detail, TrainingEvent.created_at).where(
                TrainingEvent.username == username,
                TrainingEvent.created_at >= now - timedelta(days=2),
            )
        )
    ).all()
    events = [
        (kind, detail)
        for kind, detail, created_at in rows
        if _aware(created_at).astimezone(zone).date() == today
    ]
    board = quests.quest_board(username, today, events)
    xp = 0
    for item in board["items"]:
        if item["done"] and not item["claimed"]:
            xp += await award(
                session, username, "quest_done",
                detail={"quest": item["key"], "date": board["date"]},
                request_id=f"quest:{board['date']}:{item['key']}",
            )
    if board["all_done"] and not board["chest_opened"]:
        xp += await award(
            session, username, "quests_all", detail={"date": board["date"]},
            request_id=f"quests:{board['date']}",
        )
    return xp
