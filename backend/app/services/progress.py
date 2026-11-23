"""Whether the training is working, game by game.

Training is only worth the player's time if their games change, and nothing
in the app said whether they did. This measures the player's recent games on
the three things the training aims at: big mistakes per game (the moves that
give away a tenth of the game or more), the ones that were a capture or check
allowed or missed (what Blunder Check trains), and how often the opening left
them a pawn down (what the course trains) — and compares the latest games with
the ones before, and games since training started with games before it.

A game counts only when most of the player's moves in it have a measured
evaluation; a half-analysed game would read as a clean one.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime

from sqlalchemy import Integer, Text, bindparam, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.engine_contract import MAX_PAIR_DEPTH_GAP, MIN_TRUSTED_DEPTH
from app.models.training import TrainingEvent
from app.services.points_lost import BIG_ERROR, expected_score

RECENT_GAMES = 80
WINDOW = 20
# A game is measured when this share of the player's moves are.
MIN_GAME_COVERAGE = 0.6
WORSE_AFTER_OPENING_CP = -100
OPENING_PLIES = 20

_GAMES_SQL = """
WITH
user_games AS (
    SELECT g.id, g.user_color, g.user_result, g.played_at, g.chesscom_game_url,
           CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END AS rating
    FROM games g
    WHERE g.username = :username
      AND g.time_class IN ('rapid', 'blitz')
      AND CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END >= :min_user_rating
    ORDER BY g.played_at DESC
    LIMIT :recent
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
           ar.best_move_san, ar.depth AS eval_depth
    FROM analysis_results ar
    WHERE ar.multipv_rank = 1
      AND ar.engine = 'stockfish-19'
      AND ar.engine_version = '19'
      AND ar.depth >= :min_depth
      AND (ar.eval_cp IS NOT NULL OR ar.eval_mate IS NOT NULL)
),
evaluated_gp AS MATERIALIZED (
    SELECT gp.game_id, gp.ply, gp.move_uci, ug.user_color,
           pe.eval_cp, pe.best_move_san, pe.eval_depth
    FROM game_positions gp
    JOIN user_games ug ON ug.id = gp.game_id
    JOIN position_evals pe ON pe.position_id = gp.position_id
),
ranked AS (
    SELECT child.game_id, child.ply, child.user_color,
           parent.eval_cp AS before_cp, child.eval_cp AS after_cp,
           child.best_move_san AS reply_san,
           ROW_NUMBER() OVER (
               PARTITION BY child.game_id, child.ply
               ORDER BY ABS(parent.eval_depth - child.eval_depth) ASC,
                        parent.eval_depth + child.eval_depth DESC
           ) AS eval_rank
    FROM evaluated_gp child
    JOIN evaluated_gp parent ON parent.game_id = child.game_id AND parent.ply = child.ply - 1
    WHERE child.move_uci IS NOT NULL
      AND ABS(parent.eval_depth - child.eval_depth) <= :max_pair_depth_gap
      AND (
          (child.user_color = 'white' AND child.ply % 2 = 1)
          OR (child.user_color = 'black' AND child.ply % 2 = 0)
      )
)
SELECT game_id, ply, user_color, before_cp, after_cp, reply_san
FROM ranked
WHERE eval_rank = 1
"""


def _is_forcing(san: str | None) -> bool:
    return bool(san) and ("x" in san or "+" in san or "#" in san)


def summarize(games: list[dict]) -> dict | None:
    """Averages over a run of measured games."""
    if not games:
        return None
    count = len(games)
    ratings = [game["rating"] for game in games if game["rating"]]
    by_color: dict[str, list[dict]] = defaultdict(list)
    for game in games:
        if game["cp10"] is not None:
            by_color[game["color"]].append(game)
    return {
        "games": count,
        "big_errors": round(sum(game["big_errors"] for game in games) / count, 2),
        "forcing_errors": round(sum(game["forcing_errors"] for game in games) / count, 2),
        "score": round(sum({"win": 1.0, "draw": 0.5}.get(game["result"], 0.0) for game in games) / count, 3),
        "worse_after_opening": {
            color: round(sum(1 for game in items if game["cp10"] <= WORSE_AFTER_OPENING_CP) / len(items), 3)
            for color, items in by_color.items()
        },
        # Oldest and newest rating in the run: games arrive newest first.
        "rating_from": ratings[-1] if ratings else None,
        "rating_to": ratings[0] if ratings else None,
    }


async def build_progress(session: AsyncSession, *, username: str, min_user_rating: int) -> dict:
    params = {
        "username": username,
        "min_user_rating": min_user_rating,
        "recent": RECENT_GAMES,
        "min_depth": MIN_TRUSTED_DEPTH,
        "max_pair_depth_gap": MAX_PAIR_DEPTH_GAP,
    }
    decisions = (
        await session.execute(
            text(_GAMES_SQL).bindparams(
                bindparam("username", type_=Text()),
                bindparam("max_pair_depth_gap", type_=Integer()),
            ),
            params,
        )
    ).mappings().all()
    games_sql = text("""
        SELECT g.id, g.user_color, g.user_result, g.played_at, g.chesscom_game_url,
               CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END AS rating,
               (SELECT COUNT(*) FROM game_positions gp
                 WHERE gp.game_id = g.id AND gp.move_uci IS NOT NULL
                   AND ((g.user_color = 'white' AND gp.ply % 2 = 1)
                        OR (g.user_color = 'black' AND gp.ply % 2 = 0))) AS moves
        FROM games g
        WHERE g.username = :username
          AND g.time_class IN ('rapid', 'blitz')
          AND CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END >= :min_user_rating
        ORDER BY g.played_at DESC
        LIMIT :recent
    """).bindparams(bindparam("username", type_=Text()))
    games = (
        await session.execute(
            games_sql,
            {"username": username, "min_user_rating": min_user_rating, "recent": RECENT_GAMES},
        )
    ).mappings().all()

    per_game: dict[int, dict] = defaultdict(lambda: {"analysed": 0, "big": 0, "forcing": 0, "cp10": None})
    for row in decisions:
        sign = 1 if row["user_color"] == "white" else -1
        before = sign * int(row["before_cp"])
        after = sign * int(row["after_cp"])
        stats = per_game[row["game_id"]]
        stats["analysed"] += 1
        if expected_score(before) - expected_score(after) >= BIG_ERROR:
            stats["big"] += 1
            if _is_forcing(row["reply_san"]):
                stats["forcing"] += 1
        # The position after move 10 is the child of ply 20 when the player is Black,
        # the parent of ply 21 when White: either way, the evaluation after ply 20.
        if row["ply"] == OPENING_PLIES:
            stats["cp10"] = after
        elif row["ply"] == OPENING_PLIES + 1:
            stats["cp10"] = before

    measured: list[dict] = []
    for game in games:
        stats = per_game.get(game["id"])
        moves = int(game["moves"] or 0)
        if not stats or not moves or stats["analysed"] / moves < MIN_GAME_COVERAGE:
            continue
        played_at = game["played_at"]
        # A raw query hands SQLite's timestamps back as text.
        if isinstance(played_at, str):
            played_at = datetime.fromisoformat(played_at)
        if played_at.tzinfo is None:
            played_at = played_at.replace(tzinfo=UTC)
        measured.append({
            "_at": played_at,
            "game_id": int(game["id"]),
            "played_at": played_at.isoformat(),
            "url": game["chesscom_game_url"],
            "color": game["user_color"],
            "result": game["user_result"],
            "rating": int(game["rating"]) if game["rating"] is not None else None,
            "moves": moves,
            "analysed": stats["analysed"],
            "big_errors": stats["big"],
            "forcing_errors": stats["forcing"],
            "cp10": stats["cp10"],
        })

    first_training = (
        await session.execute(
            select(TrainingEvent.created_at)
            .where(TrainingEvent.username == username)
            .order_by(TrainingEvent.created_at)
            .limit(1)
        )
    ).scalar_one_or_none()
    since: list[dict] = []
    before: list[dict] = []
    if first_training is not None:
        started = first_training if first_training.tzinfo else first_training.replace(tzinfo=UTC)
        since = [game for game in measured if game["_at"] >= started]
        before = [game for game in measured if game["_at"] < started]
    for game in measured:
        del game["_at"]

    return {
        "username": username,
        "checked_games": len(games),
        "games": measured,
        "recent": summarize(measured[:WINDOW]),
        "previous": summarize(measured[WINDOW:WINDOW * 2]),
        "training_since": first_training.isoformat() if first_training else None,
        "since_training": summarize(since),
        "before_training": summarize(before[:WINDOW]),
    }
