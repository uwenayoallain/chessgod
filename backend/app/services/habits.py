"""Habits: what the player does wrong over the board, measured from their games.

Measured on saint_uwe's 2,338 rapid/blitz games (95,964 depth-paired
decisions) before any of this was built, against their own baseline of a big
mistake (10% of winning chances) on 11.7% of moves after move 10:

- **The second mistake.** Right after one of their own big mistakes, the next
  move was another one 24.8% of the time. Held level for how the game stood:
  25.9% against 14.7% in a level position, 38.5% against 11.8% when still
  winning by three pawns. One slip turns into two.
- **The missed punishment.** After move 10 opponents made 8,347 big mistakes,
  and the player handed the advantage straight back on the very next move
  3,231 times (38.7%, re-measured with one evaluation per position, so it is
  not two readings of one noisy search).
- **The long session.** Against what the ratings predicted, games 1-4 of a
  sitting scored +3.7 points over the last year and games 5 and later −3.1.
- **Tilt after a loss did not show**: the game after a loss scored 55%,
  slightly better than average. Time of day made no difference either. Those
  are reported as good news rather than left out, because "you don't do this"
  is as useful to know as "you do".

How fast the big mistakes come is the clock card's job (`services/clock.py`)
and is not repeated here.

Every pattern carries a recent rate (last `RECENT_GAMES`) beside the earlier
one, so the player can see a habit change once they work on it, and the
newest analysed game is read for the moments where a habit showed.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from math import exp

from sqlalchemy import Text, bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.engine_contract import DECISIVE_CP, MAX_PAIR_DEPTH_GAP, MIN_TRUSTED_DEPTH

HABIT_GAMES = 1200
RECENT_GAMES = 30
OPENING_PLIES = 20
BIG = 0.10
# A new sitting starts when this long passes between one game's end and the next.
SESSION_GAP = timedelta(minutes=30)
MIN_EVENTS = 50
MIN_TAIL_GAMES = 60
# How much worse than its baseline a habit must be to be called one.
SECOND_MISTAKE_RATIO = 1.5
HANDED_BACK_SHARE = 0.25
SESSION_DROP = 0.05
TILT_DROP = 0.05
# A game is read for its moments only when most of the player's moves are judged.
COVERED_GAME = 0.6

RESULT_SCORE = {"win": 1.0, "draw": 0.5, "loss": 0.0}

_GAMES_SQL = """
SELECT g.id, g.played_at, g.user_color, g.user_result, g.time_class, g.chesscom_game_url,
       CASE WHEN g.user_color = 'white' THEN g.black_username ELSE g.white_username END AS opponent,
       CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END AS my_rating,
       CASE WHEN g.user_color = 'white' THEN g.black_rating ELSE g.white_rating END AS opp_rating
FROM games g
WHERE g.username = :username
  AND g.time_class IN ('rapid', 'blitz')
  AND CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END >= :min_user_rating
ORDER BY g.played_at DESC
LIMIT :limit
"""

_POSITIONS_SQL = """
SELECT gp.game_id, gp.ply, gp.move_san, gp.think_seconds, gp.position_id
FROM game_positions gp
WHERE gp.game_id = ANY(:game_ids)
"""

_EVALS_SQL = """
SELECT ar.position_id, ar.depth, ar.best_move_san,
       CASE
           WHEN ar.eval_cp IS NOT NULL THEN GREATEST(-CAST(:cap AS integer), LEAST(CAST(:cap AS integer), ar.eval_cp))
           WHEN ar.eval_mate > 0 THEN 2000 - LEAST(ar.eval_mate, 20) * 10
           ELSE -2000 + LEAST(-ar.eval_mate, 20) * 10
       END AS eval_cp
FROM analysis_results ar
WHERE ar.position_id IN (SELECT gp.position_id FROM game_positions gp WHERE gp.game_id = ANY(:game_ids))
  AND ar.multipv_rank = 1
  AND ar.engine = 'stockfish-19'
  AND ar.engine_version = '19'
  AND ar.depth >= :min_depth
  AND (ar.eval_cp IS NOT NULL OR ar.eval_mate IS NOT NULL)
"""


def expected_score(cp: float) -> float:
    return 1.0 / (1.0 + exp(-0.00368208 * cp))


def elo_expected(mine: int | None, theirs: int | None) -> float | None:
    if not mine or not theirs:
        return None
    return 1.0 / (1.0 + 10 ** ((theirs - mine) / 400))


def pair(parent: list[tuple[int, int, str | None]] | None,
         child: list[tuple[int, int, str | None]] | None) -> tuple[int, int, str | None] | None:
    """(before, after, best move before) from the closest-matched depths, then the deepest.

    Rows are (depth, white-perspective cp, best move SAN). None when the two
    positions share no depths within MAX_PAIR_DEPTH_GAP.
    """
    if not parent or not child:
        return None
    best = None
    for p_depth, p_cp, p_best in parent:
        for c_depth, c_cp, _ in child:
            gap = abs(p_depth - c_depth)
            if gap > MAX_PAIR_DEPTH_GAP:
                continue
            key = (gap, -(p_depth + c_depth))
            if best is None or key < best[0]:
                best = (key, p_cp, c_cp, p_best)
    return None if best is None else best[1:]


def sessions(games: list[dict]) -> dict[int, int]:
    """Each game's place in its sitting (1 = first), games given oldest first."""
    place: dict[int, int] = {}
    last_end: datetime | None = None
    index = 0
    for game in games:
        if last_end is None or game["played_at"] - last_end > SESSION_GAP:
            index = 0
        index += 1
        place[game["id"]] = index
        last_end = game["played_at"]
    return place


def read_game(game: dict, plies: dict[int, tuple], evals: dict[int, list]) -> dict:
    """The player's judged moves in one game, with what came just before each."""
    sign = 1 if game["user_color"] == "white" else -1
    mine_parity = 1 if game["user_color"] == "white" else 0
    moves: list[dict] = []
    judged = total = 0
    previous_big = False
    for ply in sorted(plies):
        if ply % 2 != mine_parity or ply < 1:
            continue
        total += 1
        san, think, position_id = plies[ply]
        parent = plies.get(ply - 1)
        if parent is None:
            continue
        measured = pair(evals.get(parent[2]), evals.get(position_id))
        if measured is None:
            previous_big = False
            continue
        judged += 1
        before = sign * measured[0]
        after = sign * measured[1]
        loss = max(0.0, expected_score(before) - expected_score(after))
        # The opponent's move into this position: did it give something away?
        gift = None
        grand = plies.get(ply - 2)
        if grand is not None and ply - 1 >= 1:
            opp = pair(evals.get(grand[2]), evals.get(parent[2]))
            if opp is not None:
                gift = expected_score(sign * opp[1]) - expected_score(sign * opp[0])
        move = {
            "ply": ply,
            "move_number": (ply + 1) // 2,
            "san": san,
            "think": think,
            "loss": loss,
            "big": loss >= BIG,
            "after_own_big": previous_big,
            "opponent_gift": gift is not None and gift >= BIG,
            "opponent_san": parent[0],
            "better_san": measured[2],
            "position_id": parent[2],
        }
        moves.append(move)
        previous_big = move["big"]
    return {"moves": moves, "judged": judged, "total": total}


def _rate(hits: int, events: int) -> float | None:
    return round(hits / events, 3) if events else None


def second_mistake(readings: list[dict]) -> dict:
    after = after_big = other = other_big = 0
    for reading in readings:
        for move in reading["moves"]:
            if move["ply"] <= OPENING_PLIES:
                continue
            if move["after_own_big"]:
                after += 1
                after_big += move["big"]
            else:
                other += 1
                other_big += move["big"]
    rate_after, rate_other = _rate(after_big, after), _rate(other_big, other)
    shows = (after >= MIN_EVENTS and rate_after is not None and rate_other
             and rate_after >= SECOND_MISTAKE_RATIO * rate_other)
    return {"events": after, "rate": rate_after, "baseline": rate_other, "shows": bool(shows)}


def missed_punishment(readings: list[dict]) -> dict:
    gifts = handed = 0
    for reading in readings:
        for move in reading["moves"]:
            if move["ply"] <= OPENING_PLIES or not move["opponent_gift"]:
                continue
            gifts += 1
            handed += move["big"]
    rate = _rate(handed, gifts)
    return {"events": gifts, "handed_back": handed, "rate": rate,
            "shows": bool(gifts >= MIN_EVENTS and rate is not None and rate >= HANDED_BACK_SHARE)}


def _over_expected(games: list[dict]) -> tuple[float | None, int]:
    diffs = []
    for game in games:
        expected = elo_expected(game["my_rating"], game["opp_rating"])
        if expected is None or game["user_result"] not in RESULT_SCORE:
            continue
        diffs.append(RESULT_SCORE[game["user_result"]] - expected)
    return (round(sum(diffs) / len(diffs), 3) if diffs else None), len(diffs)


def long_session(games: list[dict], place: dict[int, int]) -> dict:
    """The sitting length after which games score clearly below the ratings."""
    best = None
    for stop_after in (3, 4, 5, 6):
        early, n_early = _over_expected([g for g in games if place[g["id"]] <= stop_after])
        late, n_late = _over_expected([g for g in games if place[g["id"]] > stop_after])
        if early is None or late is None or n_late < MIN_TAIL_GAMES:
            continue
        drop = early - late
        if best is None or drop > best["drop"]:
            best = {"stop_after": stop_after, "early": early, "late": late, "drop": round(drop, 3),
                    "late_games": n_late}
    if best is None:
        return {"shows": False, "stop_after": None}
    return {**best, "shows": best["drop"] >= SESSION_DROP}


def tilt(games: list[dict], place: dict[int, int]) -> dict:
    ordered = sorted(games, key=lambda g: g["played_at"])
    after_loss, other = [], []
    previous = None
    for game in ordered:
        in_sitting = previous is not None and place[game["id"]] > 1
        (after_loss if in_sitting and previous["user_result"] == "loss" else other).append(game)
        previous = game
    rate_after, n_after = _over_expected(after_loss)
    rate_other, _ = _over_expected(other)
    if rate_after is None or rate_other is None or n_after < MIN_TAIL_GAMES:
        return {"shows": False, "games": n_after, "after_loss": rate_after, "otherwise": rate_other}
    return {"shows": rate_other - rate_after >= TILT_DROP, "games": n_after,
            "after_loss": rate_after, "otherwise": rate_other}


def moments(reading: dict) -> list[dict]:
    """The moves in one game where a habit showed, in game order."""
    found = []
    for move in reading["moves"]:
        if move["ply"] <= OPENING_PLIES or not move["big"]:
            continue
        if move["opponent_gift"]:
            kind = "missed_punishment"
        elif move["after_own_big"]:
            kind = "second_mistake"
        else:
            continue
        found.append({
            "kind": kind,
            "ply": move["ply"],
            "move_number": move["move_number"],
            "san": move["san"],
            "better_san": move["better_san"],
            "opponent_san": move["opponent_san"],
            "think_seconds": move["think"],
            "position_id": move["position_id"],
        })
    return found


async def _load(session: AsyncSession, *, username: str, min_user_rating: int):
    games = [
        dict(row)
        for row in (
            await session.execute(
                text(_GAMES_SQL).bindparams(bindparam("username", type_=Text())),
                {"username": username, "min_user_rating": min_user_rating, "limit": HABIT_GAMES},
            )
        ).mappings().all()
    ]
    if not games:
        return [], {}, {}
    plies: dict[int, dict[int, tuple]] = defaultdict(dict)
    for game_id, ply, san, think, position_id in (
        await session.execute(text(_POSITIONS_SQL), {"game_ids": [g["id"] for g in games]})
    ).all():
        plies[game_id][ply] = (san, think, position_id)
    evals: dict[int, list] = defaultdict(list)
    for position_id, depth, best_san, cp in (
        await session.execute(
            text(_EVALS_SQL),
            {"game_ids": [g["id"] for g in games], "min_depth": MIN_TRUSTED_DEPTH, "cap": DECISIVE_CP},
        )
    ).all():
        evals[position_id].append((int(depth), int(cp), best_san))
    return games, plies, evals


async def _fens(session: AsyncSession, position_ids: list[int]) -> list[str | None]:
    if not position_ids:
        return []
    rows = (
        await session.execute(text("SELECT id, fen FROM positions WHERE id = ANY(:ids)"), {"ids": position_ids})
    ).all()
    by_id = {int(row[0]): row[1] for row in rows}
    return [by_id.get(position_id) for position_id in position_ids]


async def build_habits(session: AsyncSession, *, username: str, min_user_rating: int) -> dict:
    games, plies, evals = await _load(session, username=username, min_user_rating=min_user_rating)
    if not games:
        return {"username": username, "games": 0, "habits": [], "last_game": None}
    oldest_first = sorted(games, key=lambda g: g["played_at"])
    place = sessions(oldest_first)
    newest_first = list(reversed(oldest_first))
    readings = {g["id"]: read_game(g, plies.get(g["id"], {}), evals) for g in newest_first}

    recent_ids = [g["id"] for g in newest_first[:RECENT_GAMES]]
    earlier_ids = [g["id"] for g in newest_first[RECENT_GAMES:]]

    def split(measure):
        whole = measure([readings[i] for i in recent_ids + earlier_ids])
        recent = measure([readings[i] for i in recent_ids])
        earlier = measure([readings[i] for i in earlier_ids])
        return {**whole, "recent_rate": recent["rate"], "recent_events": recent["events"],
                "earlier_rate": earlier["rate"]}

    session_habit = long_session(newest_first, place)
    habits = [
        {"key": "second_mistake", **split(second_mistake)},
        {"key": "missed_punishment", **split(missed_punishment)},
        {"key": "long_session", **session_habit},
        {"key": "tilt", **tilt(newest_first, place)},
    ]

    last_game = None
    pending = 0
    for game in newest_first:
        reading = readings[game["id"]]
        if reading["total"] and reading["judged"] / reading["total"] >= COVERED_GAME:
            played_at = game["played_at"]
            found = moments(reading)
            fens = await _fens(session, [moment.pop("position_id") for moment in found])
            for moment, fen in zip(found, fens):
                # The position the move was played from, so the board can go there.
                moment["fen"] = fen
            last_game = {
                "game_id": game["id"],
                "played_at": played_at.isoformat(),
                "opponent": game["opponent"],
                "user_color": game["user_color"],
                "user_result": game["user_result"],
                "game_url": game["chesscom_game_url"],
                "session_place": place[game["id"]],
                "big_mistakes": sum(1 for m in reading["moves"] if m["big"] and m["ply"] > OPENING_PLIES),
                "moments": found,
            }
            break
        # Newer than the last game read: not analysed far enough to say anything.
        pending += 1

    return {
        "username": username,
        "games": len(games),
        "recent_games": len(recent_ids),
        "habits": habits,
        "last_game": last_game,
        "pending_games": pending,
    }


_SITTING_SQL = """
SELECT g.played_at, g.user_result
FROM games g
WHERE g.username = :username
  AND g.time_class IN ('rapid', 'blitz')
ORDER BY g.played_at DESC
LIMIT 20
"""


async def current_sitting(session: AsyncSession, *, username: str, now: datetime | None = None) -> dict:
    """The games of the sitting still going on, if the last game ended within SESSION_GAP.

    Read live rather than cached: it is the one number that changes while the
    player is at the board.
    """
    now = now or datetime.now(UTC)
    rows = (
        await session.execute(
            text(_SITTING_SQL).bindparams(bindparam("username", type_=Text())), {"username": username},
        )
    ).all()
    if not rows or now - rows[0][0] > SESSION_GAP:
        return {"active": False, "games": 0, "results": []}
    results = [rows[0][1]]
    for (newer, _), (older, result) in zip(rows, rows[1:]):
        if newer - older > SESSION_GAP:
            break
        results.append(result)
    return {
        "active": True,
        "games": len(results),
        "results": list(reversed(results)),
        "last_game_at": rows[0][0].isoformat(),
    }
