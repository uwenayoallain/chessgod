"""Blunder Check: the player's own big mistakes, seen from the other side.

After the opening, 54% of the winning chances the first real player gave away
came down to a capture or a check: one they allowed (the opponent's best reply
captured, 31%, or checked, 10%) or one they missed (13%). The drills ask for
the right move *before* the mistake; this asks for the opponent's punishment
*after* it ("you played Nf6, what do they play now?") because spotting the
reply is exactly the scan that would have stopped the move: look at every
capture and check the opponent has before letting go of the piece.

Only mistakes the drill pipeline would stand behind are used: trusted Stockfish
19 rows, one measurement per decision from depths no more than
MAX_PAIR_DEPTH_GAP apart, a loss of at least `MIN_LOSS_CP`, a position that was
not already lost, and a best reply that is a capture or a check and legal on
the board.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import chess
from sqlalchemy import DateTime, Integer, bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.engine_contract import MAX_PAIR_DEPTH_GAP, MIN_TRUSTED_DEPTH
from app.models.identity import Username
from app.services.game_scope import player_rating_floor
from app.services.swr import stale_while_revalidate

MIN_LOSS_CP = 150
# A move in a position already this lost punishes nothing the player can fix.
MIN_BEFORE_CP = -300
# Newest first, so the newest 400 spanned two and a half months of one player's
# games and nothing older was ever asked. Sets now walk the pool game by game,
# so it holds the player's relevant history rather than its newest corner.
POOL_LIMIT = 1500
# A position shown and left unanswered is not asked again for this long.
SERVED_REST = timedelta(days=14)
SET_SIZE = 10

_POOL_SQL = """
WITH
user_games AS (
    SELECT g.id, g.user_color, g.chesscom_game_url, g.played_at
    FROM games g
    WHERE g.username = :username
      AND g.time_class IN ('rapid', 'blitz')
      AND CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END >= :min_user_rating
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
           ar.best_move_uci, ar.best_move_san, ar.depth AS eval_depth
    FROM analysis_results ar
    WHERE ar.multipv_rank = 1
      AND ar.engine = 'stockfish-19'
      AND ar.engine_version = '19'
      AND ar.depth >= :min_depth
      AND (ar.eval_cp IS NOT NULL OR ar.eval_mate IS NOT NULL)
),
evaluated_gp AS MATERIALIZED (
    SELECT gp.game_id, gp.ply, gp.position_id, gp.move_uci, gp.move_san,
           ug.user_color, ug.chesscom_game_url, ug.played_at,
           pe.eval_cp, pe.best_move_uci, pe.best_move_san, pe.eval_depth
    FROM game_positions gp
    JOIN user_games ug ON ug.id = gp.game_id
    JOIN position_evals pe ON pe.position_id = gp.position_id
    WHERE gp.ply > 1
),
ranked AS (
    SELECT child.game_id, child.ply, child.user_color, child.chesscom_game_url, child.played_at,
           child.position_id AS child_id,
           child.move_uci, child.move_san,
           parent.eval_cp AS before_cp, child.eval_cp AS after_cp,
           parent.best_move_uci AS better_uci, parent.best_move_san AS better_san,
           child.best_move_uci AS reply_uci, child.best_move_san AS reply_san,
           ROW_NUMBER() OVER (
               PARTITION BY child.game_id, child.ply
               ORDER BY ABS(parent.eval_depth - child.eval_depth) ASC,
                        parent.eval_depth + child.eval_depth DESC
           ) AS eval_rank
    FROM evaluated_gp child
    JOIN evaluated_gp parent
      ON parent.game_id = child.game_id
     AND parent.ply = child.ply - 1
    WHERE child.move_uci IS NOT NULL
      AND ABS(parent.eval_depth - child.eval_depth) <= :max_pair_depth_gap
      AND (
          (child.user_color = 'white' AND child.ply % 2 = 1)
          OR (child.user_color = 'black' AND child.ply % 2 = 0)
      )
)
SELECT r.game_id, r.ply, r.user_color, r.chesscom_game_url, r.played_at, r.child_id, p.fen,
       r.move_uci, r.move_san, r.before_cp, r.after_cp,
       r.better_uci, r.better_san, r.reply_uci, r.reply_san
FROM ranked r
JOIN positions p ON p.id = r.child_id
WHERE r.eval_rank = 1
  AND r.better_uci <> r.move_uci
  AND (r.reply_san LIKE '%x%' OR r.reply_san LIKE '%+%' OR r.reply_san LIKE '%#%')
  -- The loss and the position before it, from the player's side, judged on the
  -- one measurement chosen above. Filtering here instead of in Python keeps
  -- ~18k rows of small and lost-position drops off the wire.
  AND (CASE WHEN r.user_color = 'white' THEN 1 ELSE -1 END) * r.before_cp >= :min_before_cp
  AND (CASE WHEN r.user_color = 'white' THEN 1 ELSE -1 END) * (r.before_cp - r.after_cp) >= :min_loss_cp
  -- A recapture after the player's own capture (see `is_recapture`).
  AND NOT (COALESCE(r.move_san, '') LIKE '%x%'
           AND COALESCE(substr(r.reply_uci, 3, 2), '') = substr(r.move_uci, 3, 2))
ORDER BY r.played_at DESC, r.game_id DESC, r.ply
"""


def _legal(fen: str, uci: str | None) -> bool:
    if not uci:
        return False
    try:
        board = chess.Board(f"{fen} 0 1")
        return chess.Move.from_uci(uci) in board.legal_moves
    except ValueError:
        return False


def is_recapture(move_uci: str | None, move_san: str | None, reply_uci: str | None) -> bool:
    return bool(move_uci and reply_uci and move_san and "x" in move_san and move_uci[2:4] == reply_uci[2:4])


_PIECE_NAMES = {
    chess.PAWN: "pawn", chess.KNIGHT: "knight", chess.BISHOP: "bishop",
    chess.ROOK: "rook", chess.QUEEN: "queen", chess.KING: "king",
}


def hint_for(fen: str, uci: str, level: int) -> dict:
    """A graded hint toward the answer that never names the move.

    Level 1 is the kind of move (a capture, a check, a knight move), the scan
    these trainers teach; level 2 the piece and the square it stands on, which
    the page highlights. Mirrors `describeHint` in the frontend, for the two
    trainers whose answer stays on the server until the move is played.
    """
    board = chess.Board(fen if len(fen.split()) >= 6 else f"{fen} 0 1")
    move = chess.Move.from_uci(uci)
    piece = board.piece_at(move.from_square)
    name = _PIECE_NAMES.get(piece.piece_type, "piece") if piece else "piece"
    square = chess.square_name(move.from_square)
    if level >= 2:
        return {"level": 2, "text": f"Look at the {name} on {square}.", "square": square}
    capture = board.is_capture(move)
    board.push(move)
    if board.is_checkmate():
        text = "It is mate in one."
    elif capture and board.is_check():
        text = "A capture with check."
    elif capture:
        text = "A capture."
    elif board.is_check():
        text = "A check."
    else:
        text = f"A {name} move."
    return {"level": 1, "text": text, "square": None}


def kind_of(reply_san: str) -> str:
    if "#" in reply_san:
        return "mate"
    if "x" in reply_san:
        return "capture"
    return "check"


async def build_pool(session: AsyncSession, *, username: str, min_user_rating: int) -> list[dict]:
    """Every qualifying mistake, most recent first, one per position."""
    rows = await session.stream(
        text(_POOL_SQL).bindparams(
            bindparam("max_pair_depth_gap", type_=Integer()),
            bindparam("min_before_cp", type_=Integer()),
            bindparam("min_loss_cp", type_=Integer()),
            bindparam("username", type_=Username),
        ),
        {
            "username": username,
            "min_user_rating": min_user_rating,
            "min_depth": MIN_TRUSTED_DEPTH,
            "max_pair_depth_gap": MAX_PAIR_DEPTH_GAP,
            "min_before_cp": MIN_BEFORE_CP,
            "min_loss_cp": MIN_LOSS_CP,
        },
    )
    pool: list[dict] = []
    seen: set[int] = set()
    try:
        async for row in rows.mappings().yield_per(128):
            sign = 1 if row["user_color"] == "white" else -1
            before = sign * int(row["before_cp"])
            loss = before - sign * int(row["after_cp"])
            if row["child_id"] in seen:
                continue
            if not _legal(row["fen"], row["reply_uci"]):
                continue
            seen.add(row["child_id"])
            played_at = row["played_at"]
            pool.append({
                "position_id": int(row["child_id"]),
                "fen": row["fen"],
                "player_color": row["user_color"],
                "ply": int(row["ply"]),
                "your_move_uci": row["move_uci"],
                "your_move_san": row["move_san"] or row["move_uci"],
                "better_san": row["better_san"],
                "reply_uci": row["reply_uci"],
                "reply_san": row["reply_san"],
                "kind": kind_of(row["reply_san"]),
                "loss_cp": int(loss),
                "game_url": row["chesscom_game_url"],
                "played_at": played_at.isoformat() if hasattr(played_at, "isoformat") else str(played_at),
            })
            if len(pool) >= POOL_LIMIT:
                break
    finally:
        await rows.close()
    return pool


# Blunder Check's memory: a missed position comes back after a day, a found one
# rests a week, then twice as long each time it is found again in a row.
MISSED_REST = timedelta(days=1)
FOUND_REST = timedelta(days=7)
MAX_FOUND_REST = timedelta(days=56)


def schedule(answers: list[tuple[int, bool, datetime]], now: datetime) -> tuple[set[int], list[int]]:
    """Which positions are resting, and which missed ones are due again (oldest miss first).

    `answers` are (position id, spotted, when) in any order.
    """
    history: dict[int, list[tuple[datetime, bool]]] = {}
    for position_id, spotted, when in answers:
        history.setdefault(position_id, []).append((when if when.tzinfo else when.replace(tzinfo=UTC), spotted))
    resting: set[int] = set()
    due: list[tuple[datetime, int]] = []
    for position_id, events in history.items():
        events.sort()
        last_at, last_spotted = events[-1]
        if last_spotted:
            streak = 0
            for _, spotted in reversed(events):
                if not spotted:
                    break
                streak += 1
            rest = min(MAX_FOUND_REST, FOUND_REST * 2 ** (streak - 1))
        else:
            rest = MISSED_REST
        if now - last_at < rest:
            resting.add(position_id)
        elif not last_spotted:
            due.append((last_at, position_id))
    return resting, [position_id for _, position_id in sorted(due)]


def pick_set(pool: list[dict], *, exclude: set[int], due: list[int] | None = None,
             served: set[int] | None = None, size: int = SET_SIZE, seed: int | None = None) -> list[dict]:
    """Missed positions that are due first, then the pool walked game by game.

    A miss is the scan that failed, so it is what comes back: up to half the
    set, the rest new. The rest is taken newest game first, one position per
    game per pass, so a set reads across the player's games rather than three
    positions from one afternoon, and a position shown but not answered
    (`served`) waits its turn again. The old random draw from the newest half
    of the pool asked much the same positions every day and never reached an
    older game. `seed` is accepted for old callers and ignored.
    """
    del seed
    by_id = {item["position_id"]: item for item in pool}
    again = [by_id[position_id] for position_id in (due or []) if position_id in by_id][: size // 2]
    taken = {item["position_id"] for item in again}
    served = served or set()
    unseen = [item for item in pool if item["position_id"] not in exclude and item["position_id"] not in taken]
    fresh = [item for item in unseen if item["position_id"] not in served] or unseen
    if not fresh and not again:
        fresh = list(pool)
    picked = _across_games(fresh, size - len(again))
    return [{**item, "again": True} for item in again] + picked


def _across_games(items: list[dict], count: int) -> list[dict]:
    """The first `count` items taking one per game per pass, games in their given order."""
    by_game: dict[object, list[dict]] = {}
    for item in items:
        by_game.setdefault(item.get("game_url", item["position_id"]), []).append(item)
    picked: list[dict] = []
    while len(picked) < count and any(by_game.values()):
        for queue in by_game.values():
            if queue and len(picked) < count:
                picked.append(queue.pop(0))
    return picked


def served_recently(sets: list[tuple[list[int], datetime]], now: datetime) -> set[int]:
    """Positions shown in a set inside SERVED_REST, whatever became of them."""
    shown: set[int] = set()
    for position_ids, when in sets:
        when = when if when.tzinfo else when.replace(tzinfo=UTC)
        if now - when < SERVED_REST:
            shown.update(int(position_id) for position_id in position_ids)
    return shown


# Each ply counts once in the denominator, and once in the numerator when its
# position has a trusted rank-1 evaluation or is a finished position (mate or
# stalemate, which has nothing to search). Joining `analysis_results` directly
# multiplied every ply by its stored depths and MultiPV lines, inflating the
# total and reading well-analysed games as under 60%.
_RECENT_UNANALYSED_SQL = """
SELECT count(*) FROM (
    SELECT g.id,
           count(*) AS total,
           sum(CASE WHEN EXISTS (
                        SELECT 1 FROM analysis_results ar
                        WHERE ar.position_id = gp.position_id
                          AND ar.multipv_rank = 1
                          AND ar.engine = 'stockfish-19' AND ar.engine_version = '19'
                          AND ar.depth >= :min_depth
                          AND (ar.eval_cp IS NOT NULL OR ar.eval_mate IS NOT NULL)
                    )
                    OR EXISTS (SELECT 1 FROM position_outcomes po WHERE po.position_id = gp.position_id)
                    THEN 1 ELSE 0 END) AS done
    FROM games g
    JOIN game_positions gp ON gp.game_id = g.id
    WHERE g.username = :username
      AND g.time_class IN ('rapid', 'blitz')
      AND g.played_at >= :since
    GROUP BY g.id
) AS recent
WHERE total > 0 AND done * 10 < total * 6
"""


async def recent_unanalysed_games(session: AsyncSession, *, username: str, now: datetime | None = None,
                                  days: int = 30) -> int:
    """Games from the last `days` with under 60% of their positions evaluated.

    Their mistakes cannot be in the pool yet, and a player who sees August
    positions while their games from this week go unmentioned reads it as the
    app not looking at their games. The card says so instead.
    """
    now = now or datetime.now(UTC)
    return int((await session.execute(
        text(_RECENT_UNANALYSED_SQL).bindparams(
            bindparam("username", type_=Username), bindparam("since", type_=DateTime(timezone=True)),
        ),
        {"username": username, "min_depth": MIN_TRUSTED_DEPTH, "since": now - timedelta(days=days)},
    )).scalar_one() or 0)


# Punish it: the mirror image. After move 10 the first player's opponents made
# 8,347 big mistakes and the player handed the advantage straight back on the
# next move 3,231 times (38.7%, services/habits.py), the largest single habit
# measured. This shows the position right after the opponent's mistake, with
# the player to move, and asks for the move that keeps what was given: the
# engine's best move there, when it is a capture, a check or a mate, so the
# question is the same scan Blunder Check trains and has one answer.
MIN_GIFT_CP = 150
# Already this far ahead, the gift changes little and the hand-back is a slip in a won game.
MAX_BEFORE_GIFT_CP = 300
PUNISH_OPENING_PLIES = 20

_PUNISH_SQL = """
WITH
user_games AS (
    SELECT g.id, g.user_color, g.chesscom_game_url, g.played_at
    FROM games g
    WHERE g.username = :username
      AND g.time_class IN ('rapid', 'blitz')
      AND CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END >= :min_user_rating
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
           ar.best_move_uci, ar.best_move_san, ar.depth AS eval_depth
    FROM analysis_results ar
    WHERE ar.multipv_rank = 1
      AND ar.engine = 'stockfish-19'
      AND ar.engine_version = '19'
      AND ar.depth >= :min_depth
      AND (ar.eval_cp IS NOT NULL OR ar.eval_mate IS NOT NULL)
),
evaluated_gp AS MATERIALIZED (
    SELECT gp.game_id, gp.ply, gp.position_id, gp.move_uci, gp.move_san,
           ug.user_color, ug.chesscom_game_url, ug.played_at,
           pe.eval_cp, pe.best_move_uci, pe.best_move_san, pe.eval_depth
    FROM game_positions gp
    JOIN user_games ug ON ug.id = gp.game_id
    JOIN position_evals pe ON pe.position_id = gp.position_id
    WHERE gp.ply >= :opening_plies
),
ranked AS (
    SELECT mine.game_id, mine.ply, mine.user_color, mine.chesscom_game_url, mine.played_at,
           gift.position_id AS gift_id,
           gift.move_uci AS their_uci, gift.move_san AS their_san,
           mine.move_uci AS your_uci, mine.move_san AS your_san,
           before.eval_cp AS before_cp, gift.eval_cp AS gift_cp, mine.eval_cp AS after_cp,
           gift.best_move_uci AS answer_uci, gift.best_move_san AS answer_san,
           ROW_NUMBER() OVER (
               PARTITION BY mine.game_id, mine.ply
               ORDER BY ABS(before.eval_depth - gift.eval_depth) + ABS(gift.eval_depth - mine.eval_depth) ASC,
                        before.eval_depth + gift.eval_depth + mine.eval_depth DESC
           ) AS eval_rank
    FROM evaluated_gp mine
    JOIN evaluated_gp gift ON gift.game_id = mine.game_id AND gift.ply = mine.ply - 1
    JOIN evaluated_gp before ON before.game_id = mine.game_id AND before.ply = mine.ply - 2
    WHERE mine.move_uci IS NOT NULL
      AND gift.move_uci IS NOT NULL
      AND ABS(before.eval_depth - gift.eval_depth) <= :max_pair_depth_gap
      AND ABS(gift.eval_depth - mine.eval_depth) <= :max_pair_depth_gap
      AND (
          (mine.user_color = 'white' AND mine.ply % 2 = 1)
          OR (mine.user_color = 'black' AND mine.ply % 2 = 0)
      )
)
SELECT r.game_id, r.ply, r.user_color, r.chesscom_game_url, r.played_at, r.gift_id, p.fen,
       r.their_uci, r.their_san, r.your_uci, r.your_san,
       r.before_cp, r.gift_cp, r.after_cp, r.answer_uci, r.answer_san
FROM ranked r
JOIN positions p ON p.id = r.gift_id
WHERE r.eval_rank = 1
  AND r.answer_uci <> r.your_uci
  AND (r.answer_san LIKE '%x%' OR r.answer_san LIKE '%+%' OR r.answer_san LIKE '%#%')
  -- The gift, the position before it, and the hand-back, from the player's side.
  AND (CASE WHEN r.user_color = 'white' THEN 1 ELSE -1 END) * r.before_cp <= :max_before_gift_cp
  AND (CASE WHEN r.user_color = 'white' THEN 1 ELSE -1 END) * (r.gift_cp - r.before_cp) >= :min_gift_cp
  AND (CASE WHEN r.user_color = 'white' THEN 1 ELSE -1 END) * (r.gift_cp - r.after_cp) >= :min_gift_cp
ORDER BY r.played_at DESC, r.game_id DESC, r.ply
"""


async def build_punish_pool(session: AsyncSession, *, username: str, min_user_rating: int) -> list[dict]:
    """Opponents' big mistakes the player handed straight back, most recent first."""
    rows = await session.stream(
        text(_PUNISH_SQL).bindparams(
            bindparam("max_pair_depth_gap", type_=Integer()),
            bindparam("max_before_gift_cp", type_=Integer()),
            bindparam("min_gift_cp", type_=Integer()),
            bindparam("username", type_=Username),
        ),
        {
            "username": username,
            "min_user_rating": min_user_rating,
            "min_depth": MIN_TRUSTED_DEPTH,
            "max_pair_depth_gap": MAX_PAIR_DEPTH_GAP,
            "opening_plies": PUNISH_OPENING_PLIES,
            "max_before_gift_cp": MAX_BEFORE_GIFT_CP,
            "min_gift_cp": MIN_GIFT_CP,
        },
    )
    pool: list[dict] = []
    seen: set[int] = set()
    try:
        async for row in rows.mappings().yield_per(128):
            sign = 1 if row["user_color"] == "white" else -1
            before = sign * int(row["before_cp"])
            gift = sign * int(row["gift_cp"])
            if row["gift_id"] in seen:
                continue
            if not _legal(row["fen"], row["answer_uci"]):
                continue
            seen.add(row["gift_id"])
            played_at = row["played_at"]
            pool.append({
                "position_id": int(row["gift_id"]),
                "fen": row["fen"],
                "player_color": row["user_color"],
                "ply": int(row["ply"]),
                "their_move_uci": row["their_uci"],
                "their_move_san": row["their_san"] or row["their_uci"],
                "your_move_san": row["your_san"] or row["your_uci"],
                "answer_uci": row["answer_uci"],
                "answer_san": row["answer_san"],
                "kind": kind_of(row["answer_san"]),
                "gift_cp": int(gift - before),
                "game_url": row["chesscom_game_url"],
                "played_at": played_at.isoformat() if hasattr(played_at, "isoformat") else str(played_at),
            })
            if len(pool) >= POOL_LIMIT:
                break
    finally:
        await rows.close()
    return pool


async def cached_threat_pool(
    session: AsyncSession, username: str, *, min_user_rating: int | None = None,
) -> list[dict]:
    return await _cached_pool(session, username, min_user_rating, punish=False)


async def cached_punish_pool(
    session: AsyncSession, username: str, *, min_user_rating: int | None = None,
) -> list[dict]:
    return await _cached_pool(session, username, min_user_rating, punish=True)


async def _cached_pool(
    session: AsyncSession, username: str, floor: int | None, *, punish: bool,
) -> list[dict]:
    if floor is None:
        floor = await player_rating_floor(session, username)
    suffix = f"{username}:{floor}"
    build = build_punish_pool if punish else build_pool

    async def compute(db: AsyncSession) -> list[dict]:
        return await build(db, username=username, min_user_rating=floor)

    # Both fresh entries share the prefix invalidated by uploads and imports.
    return await stale_while_revalidate(
        session,
        fresh_base=f"improvement:threats:{suffix}:punish" if punish else f"improvement:threats:{suffix}",
        last_key=f"training:punishlast:{suffix}" if punish else f"training:threatslast:{suffix}",
        compute=compute,
        fresh_ttl=1_800.0,
    )
