from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import TypeVar

from sqlalchemy import Integer, Text, bindparam, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.engine_contract import MAX_PAIR_DEPTH_GAP
from app.models.opening_family import OpeningFamily
from app.services.swr import stale_while_revalidate
from app.models.position import Position
from app.schemas.theory import MistakeOut, TheoryMove

_T = TypeVar("_T")
QUERY_BATCH_SIZE = 1000


def compute_cp_loss(parent_eval_cp: int, child_eval_cp: int, mover_is_white: bool) -> int:
    return max(0, parent_eval_cp - child_eval_cp) if mover_is_white else max(0, child_eval_cp - parent_eval_cp)


def classify_engine_drop(cp_loss: int) -> str:
    if cp_loss > 200:
        return "blunder"
    if cp_loss > 100:
        return "mistake"
    return "inaccuracy"


def _chunked(items: Sequence[_T], size: int = QUERY_BATCH_SIZE) -> Iterator[list[_T]]:
    for start in range(0, len(items), size):
        yield list(items[start:start + size])


# Single CTE query that replaces the old Python-loop scan.
# Structure:
#   user_games    — games matching username / color / optional family root
#   best_evals    — deepest rank-1 eval per position (covering index hit on PG)
#   evaluated_gp  — MATERIALIZED: game-position rows restricted to evaluated
#                   positions, with the eval columns denormalized in. Only a
#                   couple hundred thousand rows survive out of millions of
#                   game_positions, so game_positions is scanned exactly once
#                   and the parent/child self-join runs on the small set.
#                   (The old shape self-joined the full table: two multi-second
#                   scans, ~9s total at 3M rows.)
#   master_top3   — top-3 master moves per parent position (index hit on PG)
# Main body groups by (parent_position_id, move_uci); parent FENs are resolved
# afterwards with an indexed lookup instead of hash-joining all of positions.
#
# Compatible with both PostgreSQL (production) and SQLite (tests):
# ROW_NUMBER() is available in SQLite ≥ 3.25, MATERIALIZED in ≥ 3.35, and the
# % operator works the same.
_MISTAKES_SQL = text("""
WITH
user_games AS (
    SELECT g.id, g.user_color
    FROM games g
    WHERE g.username = :username
      AND (:color = 'both' OR g.user_color = :color)
      AND (
          :time_class IS NULL
          OR (:time_class = 'rapid_blitz' AND g.time_class IN ('rapid', 'blitz'))
          OR g.time_class = :time_class
      )
      AND (:family_pos_id IS NULL OR EXISTS (
          SELECT 1 FROM game_positions gp_fam
          WHERE gp_fam.game_id = g.id AND gp_fam.position_id = :family_pos_id
      ))
),
-- One row per searched depth. An evaluation loss is the difference between two
-- positions, so both sides have to be compared at a depth they were both
-- searched to; see MAX_PAIR_DEPTH_GAP in engine_contract.py.
position_evals AS (
    SELECT ar.position_id,
           CASE
               -- Capped at DECISIVE_CP (engine_contract.py): past it a score
               -- says only "decisive", and uncapped it ranks endgame
               -- tablebase scores as 80-pawn blunders.
               WHEN ar.eval_cp > 1500 THEN 1500
               WHEN ar.eval_cp < -1500 THEN -1500
               WHEN ar.eval_cp IS NOT NULL THEN ar.eval_cp
               WHEN ar.eval_mate > 0
                   THEN 2000 - (CASE WHEN ar.eval_mate > 20 THEN 20 ELSE ar.eval_mate END) * 10
               ELSE -2000 + (CASE WHEN ar.eval_mate < -20 THEN 20 ELSE -ar.eval_mate END) * 10
           END AS eval_cp,
           ar.eval_mate, ar.best_move_uci, ar.best_move_san, NULL AS terminal_result,
           0 AS terminal_priority, ar.depth AS eval_depth
    FROM analysis_results ar
    WHERE ar.multipv_rank = 1
      AND ar.engine = 'stockfish-19'
      AND ar.engine_version = '19'
      AND ar.depth >= :min_depth
      AND (ar.eval_cp IS NOT NULL OR ar.eval_mate IS NOT NULL)
    UNION ALL
    SELECT position_id, white_result * 2000, NULL, NULL, NULL, white_result,
           1, NULL
    FROM position_outcomes
),
evaluated_gp AS MATERIALIZED (
    SELECT gp.game_id, gp.ply, gp.position_id, gp.move_uci, gp.move_san,
           ug.user_color, pe.eval_cp, pe.eval_mate, pe.best_move_uci, pe.best_move_san,
           pe.terminal_result, pe.terminal_priority, pe.eval_depth
    FROM game_positions gp
    JOIN position_evals pe ON pe.position_id = gp.position_id
    JOIN user_games ug ON ug.id = gp.game_id
),
master_top3 AS (
    SELECT from_position_id, move_uci
    FROM (
        SELECT pm.from_position_id, pm.move_uci,
               ROW_NUMBER() OVER (
                   PARTITION BY pm.from_position_id
                   ORDER BY pm.master_game_count DESC, pm.game_count DESC
               ) AS rn
        FROM position_moves pm
        WHERE pm.master_game_count IS NOT NULL
    ) _mt
    WHERE rn <= 3
),
-- Every parent/child pair searched to comparable depths: one candidate
-- measurement of the decision per depth the two positions share.
pair_candidates AS (
    SELECT
        par_gp.position_id                                  AS parent_position_id,
        child_gp.game_id                                    AS game_id,
        child_gp.ply                                        AS ply,
        COALESCE(child_gp.move_san, child_gp.move_uci)      AS move_san,
        child_gp.move_uci                                   AS move_uci,
        child_gp.user_color                                 AS user_color,
        par_gp.best_move_uci                                AS best_move_uci,
        par_gp.best_move_san                                AS best_move_san,
        par_gp.eval_mate                                    AS parent_eval_mate,
        child_gp.eval_mate                                  AS child_eval_mate,
        child_gp.terminal_result                            AS child_terminal_result,
        CASE
            WHEN child_gp.user_color = 'white' THEN par_gp.eval_cp - child_gp.eval_cp
            ELSE child_gp.eval_cp - par_gp.eval_cp
        END                                                 AS cp_loss,
        ROW_NUMBER() OVER (
            PARTITION BY child_gp.game_id, child_gp.ply
            ORDER BY par_gp.terminal_priority + child_gp.terminal_priority DESC,
                     CASE
                         WHEN par_gp.eval_depth IS NULL OR child_gp.eval_depth IS NULL THEN 0
                         ELSE ABS(par_gp.eval_depth - child_gp.eval_depth)
                     END ASC,
                     COALESCE(par_gp.eval_depth, 0) + COALESCE(child_gp.eval_depth, 0) DESC
        )                                                   AS eval_rank
    FROM evaluated_gp child_gp
    JOIN evaluated_gp par_gp
        ON par_gp.game_id = child_gp.game_id
       AND par_gp.ply    = child_gp.ply - 1
    JOIN (SELECT DISTINCT from_position_id FROM master_top3) has_master
        ON has_master.from_position_id = par_gp.position_id
    LEFT JOIN master_top3 mt
        ON mt.from_position_id = par_gp.position_id
       AND mt.move_uci        = child_gp.move_uci
    WHERE mt.move_uci IS NULL
      AND child_gp.ply > 0
      AND child_gp.move_uci IS NOT NULL
      -- Comparing a depth-30 parent with a depth-22 child charges the extra
      -- eight plies of search to the player. Stockfish reports the depth it
      -- finished on, so a ply or two of slack is the search, not the player.
      AND (
          par_gp.eval_depth IS NULL
          OR child_gp.eval_depth IS NULL
          OR ABS(par_gp.eval_depth - child_gp.eval_depth) <= :max_pair_depth_gap
      )
      AND (
          (child_gp.user_color = 'white' AND child_gp.ply % 2 = 1) OR
          (child_gp.user_color = 'black' AND child_gp.ply % 2 = 0)
      )
),
-- What the decision is worth, judged only after which searches measure it has
-- been settled.
measured_decisions AS (
    SELECT * FROM pair_candidates
    WHERE eval_rank = 1
      -- Independent searches can change the score of the same best line. Never
      -- turn that search instability into a mistake attributed to the player.
      AND best_move_uci IS NOT NULL
      AND move_uci <> best_move_uci
      -- Do not count shortening an already unavoidable mate as another error.
      AND NOT (
          (user_color = 'white' AND COALESCE(parent_eval_mate, 0) < 0)
          OR (user_color = 'black' AND COALESCE(parent_eval_mate, 0) > 0)
      )
      -- Winning a forced mate is not a loss of winning chances, regardless of
      -- the numeric placeholder used for mate or an earlier large CP evaluation.
      AND NOT (
          (user_color = 'white' AND
              (COALESCE(child_eval_mate, 0) > 0 OR COALESCE(child_terminal_result, 0) = 1))
          OR (user_color = 'black' AND
              (COALESCE(child_eval_mate, 0) < 0 OR COALESCE(child_terminal_result, 0) = -1))
      )
      AND cp_loss > :threshold_cp
)
SELECT
    parent_position_id,
    MIN(ply)           AS ply,
    MAX(move_san)      AS move_san,
    move_uci,
    MAX(best_move_uci) AS best_move_uci,
    MAX(best_move_san) AS best_move_san,
    MAX(cp_loss)       AS max_loss,
    COUNT(*)           AS occurrences
FROM measured_decisions
GROUP BY parent_position_id, move_uci
HAVING COUNT(*) >= :min_occurrences
ORDER BY max_loss DESC, occurrences DESC
""").bindparams(
    # asyncpg requires an explicit type for nullable integer parameters; without
    # it, PostgreSQL raises AmbiguousParameterError when family_pos_id is NULL.
    bindparam("family_pos_id", type_=Integer()),
    bindparam("time_class", type_=Text()),
    bindparam("max_pair_depth_gap", type_=Integer()),
)


async def find_mistakes(
    session: AsyncSession,
    username: str,
    *,
    color: str,
    time_class: str | None = None,
    family_id: int | None = None,
    min_occurrences: int = 2,
    threshold_cp: int = 50,
    min_depth: int = 18,
) -> list[MistakeOut]:
    family_root_position_id: int | None = None
    if family_id is not None:
        family = await session.get(OpeningFamily, family_id)
        if family is None:
            return []
        family_root_position_id = await session.scalar(
            select(Position.id).where(Position.fen == family.root_fen)
        )
        if family_root_position_id is None:
            return []

    # PostgreSQL badly under-estimates the row count of the window-function CTEs
    # (position_evals / master_top3 collapse to ~1 row in the planner's eyes), so it
    # picks a nested-loop plan that fans out every game occurrence of popular
    # early positions and runs for minutes. Forcing hash/merge joins for just
    # this transaction turns the same query into a ~0.5s run. SET LOCAL is
    # transaction-scoped, so it never leaks to other pooled connections, and we
    # skip it on SQLite (tests), which has no such planner GUC.
    if session.bind is not None and session.bind.dialect.name == "postgresql":
        await session.execute(text("SET LOCAL enable_nestloop = off"))

    rows = await session.execute(
        _MISTAKES_SQL,
        {
            "username": username,
            "color": color,
            "time_class": time_class,
            "family_pos_id": family_root_position_id,
            "min_depth": min_depth,
            "threshold_cp": threshold_cp,
            "min_occurrences": min_occurrences,
            "max_pair_depth_gap": MAX_PAIR_DEPTH_GAP,
        },
    )
    results = rows.mappings().all()
    if not results:
        return []

    # Resolve parent FENs via the primary key instead of joining the whole
    # positions table (millions of rows) inside the hash-join-only query above.
    fen_by_position_id: dict[int, str] = {}
    parent_ids = list({int(row["parent_position_id"]) for row in results})
    for batch in _chunked(parent_ids):
        fen_rows = await session.execute(
            select(Position.id, Position.fen).where(Position.id.in_(batch))
        )
        for position_id, fen in fen_rows.all():
            fen_by_position_id[int(position_id)] = fen

    parent_fens = list(set(fen_by_position_id.values()))
    families_by_fen: dict[str, OpeningFamily] = {}
    for batch in _chunked(parent_fens):
        family_rows = await session.execute(
            select(OpeningFamily)
            .where(OpeningFamily.root_fen.in_(batch))
            .order_by(OpeningFamily.root_fen.asc(), OpeningFamily.depth.desc(), OpeningFamily.id.desc())
        )
        for fam in family_rows.scalars().all():
            families_by_fen.setdefault(fam.root_fen, fam)

    mistakes: list[MistakeOut] = []
    for row in results:
        parent_fen = fen_by_position_id.get(int(row["parent_position_id"]), "")
        fam = families_by_fen.get(parent_fen)
        mistakes.append(
            MistakeOut(
                parent_fen=parent_fen,
                ply=int(row["ply"]),
                user_move=TheoryMove(
                    san=row["move_san"],
                    uci=row["move_uci"],
                    game_count=int(row["occurrences"]),
                    win_rate=None,
                ),
                best_move=TheoryMove(
                    san=row["best_move_san"] or row["best_move_uci"],
                    uci=row["best_move_uci"],
                    game_count=0,
                    win_rate=None,
                ),
                eval_drop_cp=int(row["max_loss"]),
                severity=classify_engine_drop(int(row["max_loss"])),
                occurrences=int(row["occurrences"]),
                family_id=fam.id if fam else None,
                family_name=fam.full_name if fam else None,
            )
        )

    return mistakes


# find_mistakes previously scanned all of a user's games/positions/evals in
# Python (~20s cold) before the SQL rewrite. The TTL cache remains: the cold
# path is now ~2s but the frontend staleTime is 2 min, so the shared cache
# (Redis, in-process fallback) eliminates redundant requests in that window.
_MISTAKES_TTL_SECONDS = 600.0  # evidence uploads bump its generation


async def find_mistakes_cached(
    session: AsyncSession,
    username: str,
    *,
    color: str,
    time_class: str | None = None,
    family_id: int | None = None,
    min_occurrences: int = 2,
    threshold_cp: int = 50,
    min_depth: int = 18,
) -> list[MistakeOut]:
    suffix = f"{username}:{color}:{time_class}:{family_id}:{min_occurrences}:{threshold_cp}:{min_depth}"

    async def compute(db: AsyncSession) -> list[dict]:
        result = await find_mistakes(
            db,
            username,
            color=color,
            time_class=time_class,
            family_id=family_id,
            min_occurrences=min_occurrences,
            threshold_cp=threshold_cp,
            min_depth=min_depth,
        )
        return [mistake.model_dump(mode="json") for mistake in result]

    # Every evidence upload bumps the generation, so a plain cache was cold on
    # most visits (~0.6s); the last list is served while the new one builds.
    payload = await stale_while_revalidate(
        session,
        fresh_base=f"mistakes:v7:{suffix}",
        last_key=f"mistakes:last:{suffix}",
        compute=compute,
        fresh_ttl=_MISTAKES_TTL_SECONDS,
    )
    return [MistakeOut.model_validate(item) for item in payload]
