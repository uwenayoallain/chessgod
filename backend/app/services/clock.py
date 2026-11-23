"""How the player spends their clock, and whether that is where the points go.

The usual guess about a club player's mistakes is time trouble. On the first
player's rapid games it was the opposite: they lost with a median of six of
their ten minutes unused, and 87% of their big mistakes were played with five
minutes or more on the clock — half of them in under ten seconds. Mistakes
were *rarer* in time trouble, not commoner. This measures that for any
player, on their main time control, so the card can say which it is.
"""

from __future__ import annotations

import statistics
from collections import Counter

from sqlalchemy import Integer, Text, bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.engine_contract import MAX_PAIR_DEPTH_GAP, MIN_TRUSTED_DEPTH
from app.services.points_lost import BIG_ERROR, expected_score

CLOCK_GAMES = 300
MIN_GAMES = 20
MIN_MISTAKES = 30
OPENING_PLIES = 20
# "Hasty": a big mistake played this fast while at least half the clock was left.
HASTY_SECONDS = 10
THINK_BANDS = ((0, 3, "Under 3s"), (3, 10, "3-10s"), (10, 30, "10-30s"), (30, None, "30s or more"))
# How a game that reached move 30 scored, by the share of the clock left at its end.
FINISH_BANDS = ((0.5, None, "Half or more"), (0.3, 0.5, "30-50%"), (0.1, 0.3, "10-30%"), (0, 0.1, "Under 10%"))
FINISH_MIN_PLIES = 60
RESULT_SCORE = {"win": 1.0, "draw": 0.5, "loss": 0.0}

_CONTROLS_SQL = """
SELECT g.time_control, g.time_class, COUNT(*) AS games
FROM games g
WHERE g.username = :username
  AND g.time_class IN ('rapid', 'blitz')
  AND g.time_control IS NOT NULL
  AND CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END >= :min_user_rating
GROUP BY g.time_control, g.time_class
"""

_GAMES_SQL = """
SELECT g.id, g.user_result, g.num_moves,
       (SELECT gp.clock_seconds_after FROM game_positions gp
         WHERE gp.game_id = g.id AND gp.clock_seconds_after IS NOT NULL
           AND ((g.user_color = 'white' AND gp.ply % 2 = 1) OR (g.user_color = 'black' AND gp.ply % 2 = 0))
         ORDER BY gp.ply DESC LIMIT 1) AS last_clock
FROM games g
WHERE g.username = :username
  AND g.time_control = :time_control
  AND CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END >= :min_user_rating
ORDER BY g.played_at DESC
LIMIT :limit
"""

_DECISIONS_SQL = """
WITH
user_games AS (
    SELECT g.id, g.user_color
    FROM games g
    WHERE g.username = :username
      AND g.time_control = :time_control
      AND CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END >= :min_user_rating
    ORDER BY g.played_at DESC
    LIMIT :limit
),
position_evals AS (
    SELECT ar.position_id,
           CASE
               WHEN ar.eval_cp > 1500 THEN 1500
               WHEN ar.eval_cp < -1500 THEN -1500
               WHEN ar.eval_cp IS NOT NULL THEN ar.eval_cp
               WHEN ar.eval_mate > 0
                   THEN 2000 - (CASE WHEN ar.eval_mate > 20 THEN 20 ELSE ar.eval_mate END) * 10
               ELSE -2000 + (CASE WHEN ar.eval_mate < -20 THEN 20 ELSE -ar.eval_mate END) * 10
           END AS eval_cp,
           ar.depth AS eval_depth
    FROM analysis_results ar
    WHERE ar.multipv_rank = 1
      AND ar.engine = 'stockfish-19'
      AND ar.engine_version = '19'
      AND ar.depth >= :min_depth
      AND (ar.eval_cp IS NOT NULL OR ar.eval_mate IS NOT NULL)
),
evaluated_gp AS MATERIALIZED (
    SELECT gp.game_id, gp.ply, gp.move_uci, gp.think_seconds, gp.clock_seconds_after, ug.user_color,
           pe.eval_cp, pe.eval_depth
    FROM game_positions gp
    JOIN user_games ug ON ug.id = gp.game_id
    JOIN position_evals pe ON pe.position_id = gp.position_id
),
ranked AS (
    SELECT child.user_color, child.think_seconds, child.clock_seconds_after,
           parent.eval_cp AS before_cp, child.eval_cp AS after_cp,
           ROW_NUMBER() OVER (
               PARTITION BY child.game_id, child.ply
               ORDER BY ABS(parent.eval_depth - child.eval_depth) ASC,
                        parent.eval_depth + child.eval_depth DESC
           ) AS eval_rank
    FROM evaluated_gp child
    JOIN evaluated_gp parent ON parent.game_id = child.game_id AND parent.ply = child.ply - 1
    WHERE child.move_uci IS NOT NULL
      AND child.ply > :opening_plies
      AND child.think_seconds IS NOT NULL
      AND child.clock_seconds_after IS NOT NULL
      AND ABS(parent.eval_depth - child.eval_depth) <= :max_pair_depth_gap
      AND (
          (child.user_color = 'white' AND child.ply % 2 = 1)
          OR (child.user_color = 'black' AND child.ply % 2 = 0)
      )
)
SELECT user_color, think_seconds, clock_seconds_after, before_cp, after_cp
FROM ranked
WHERE eval_rank = 1
"""


def parse_control(time_control: str) -> tuple[float, float] | None:
    """Starting seconds and increment, or None for a daily or unknown control."""
    if not time_control or "/" in time_control:
        return None
    base, _, increment = time_control.partition("+")
    try:
        return float(base), float(increment or 0)
    except ValueError:
        return None


def main_control(controls: list[tuple[str, str, int]]) -> tuple[str, str] | None:
    """The control most games were played at, rapid first when it has enough games."""
    usable = [(control, time_class, games) for control, time_class, games in controls if parse_control(control)]
    rapid = [row for row in usable if row[1] == "rapid" and row[2] >= MIN_GAMES]
    pool = rapid or usable
    if not pool:
        return None
    control, time_class, _ = max(pool, key=lambda row: row[2])
    return control, time_class


def _median(values: list[float]) -> float | None:
    return round(statistics.median(values), 1) if values else None


def verdict(summary: dict) -> str:
    if summary["games"] < MIN_GAMES or summary["mistakes"] < MIN_MISTAKES:
        return "insufficient"
    if summary["mistakes_in_time_trouble"] >= 0.25:
        return "time_trouble"
    loss_share = (summary["left_in_losses"] or 0) / summary["initial_seconds"]
    if summary["mistakes_with_half_clock"] >= 0.5 and loss_share >= 0.3:
        return "unused"
    return "balanced"


async def build_clock(session: AsyncSession, *, username: str, min_user_rating: int) -> dict:
    controls = (
        await session.execute(
            text(_CONTROLS_SQL).bindparams(bindparam("username", type_=Text())),
            {"username": username, "min_user_rating": min_user_rating},
        )
    ).all()
    chosen = main_control([(row[0], row[1], int(row[2])) for row in controls])
    if chosen is None:
        return {"username": username, "verdict": "insufficient", "games": 0, "mistakes": 0}
    control, time_class = chosen
    initial, increment = parse_control(control)  # type: ignore[misc]
    params = {
        "username": username,
        "time_control": control,
        "min_user_rating": min_user_rating,
        "limit": CLOCK_GAMES,
    }
    games = (
        await session.execute(
            text(_GAMES_SQL).bindparams(bindparam("username", type_=Text())), params,
        )
    ).mappings().all()
    decisions = (
        await session.execute(
            text(_DECISIONS_SQL).bindparams(
                bindparam("username", type_=Text()),
                bindparam("max_pair_depth_gap", type_=Integer()),
            ),
            {
                **params,
                "min_depth": MIN_TRUSTED_DEPTH,
                "max_pair_depth_gap": MAX_PAIR_DEPTH_GAP,
                "opening_plies": OPENING_PLIES,
            },
        )
    ).mappings().all()

    left_by_result: dict[str, list[float]] = {"win": [], "loss": [], "draw": []}
    finish_scores: dict[str, list[float]] = {label: [] for _, _, label in FINISH_BANDS}
    for game in games:
        if game["last_clock"] is None or game["user_result"] not in left_by_result:
            continue
        left = float(game["last_clock"])
        left_by_result[game["user_result"]].append(left)
        if (game["num_moves"] or 0) >= FINISH_MIN_PLIES:
            share = left / initial
            band = next(label for low, high, label in FINISH_BANDS
                        if share >= low and (high is None or share < high))
            finish_scores[band].append(RESULT_SCORE[game["user_result"]])

    thinks: list[float] = []
    mistakes: list[tuple[float, float]] = []
    band_moves: Counter[str] = Counter()
    band_mistakes: Counter[str] = Counter()
    for row in decisions:
        sign = 1 if row["user_color"] == "white" else -1
        think = float(row["think_seconds"])
        # The clock as the player looked at it, before the move and its increment.
        left = float(row["clock_seconds_after"]) + think - increment
        band = next(label for low, high, label in THINK_BANDS if think >= low and (high is None or think < high))
        thinks.append(think)
        band_moves[band] += 1
        if expected_score(sign * int(row["before_cp"])) - expected_score(sign * int(row["after_cp"])) >= BIG_ERROR:
            mistakes.append((think, left))
            band_mistakes[band] += 1

    count = len(mistakes)
    summary = {
        "username": username,
        "time_control": control,
        "time_class": time_class,
        "initial_seconds": initial,
        "increment": increment,
        "games": len(games),
        "losses": len(left_by_result["loss"]),
        "left_in_losses": _median(left_by_result["loss"]),
        "left_in_wins": _median(left_by_result["win"]),
        "think_after_opening": _median(thinks),
        "moves": len(thinks),
        "mistakes": count,
        "mistake_think": _median([think for think, _ in mistakes]),
        "mistake_left": _median([left for _, left in mistakes]),
        "mistakes_with_half_clock": round(
            sum(1 for _, left in mistakes if left >= initial / 2) / count, 3) if count else 0.0,
        "hasty_mistakes": round(
            sum(1 for think, left in mistakes if think < HASTY_SECONDS and left >= initial / 2) / count, 3,
        ) if count else 0.0,
        "mistakes_in_time_trouble": round(
            sum(1 for _, left in mistakes if left < initial / 10) / count, 3) if count else 0.0,
        "by_finish": [
            {
                "label": label,
                "games": len(finish_scores[label]),
                "score": round(sum(finish_scores[label]) / len(finish_scores[label]), 3)
                if finish_scores[label] else None,
            }
            for _, _, label in FINISH_BANDS
        ],
        "by_think": [
            {"label": label, "moves": band_moves[label], "mistakes": band_mistakes[label]}
            for _, _, label in THINK_BANDS
        ],
    }
    summary["verdict"] = verdict(summary)
    return summary
