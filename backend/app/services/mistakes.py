from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import TypeVar

from sqlalchemy import Integer, Text, bindparam, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.engine_contract import MAX_PAIR_DEPTH_GAP
from app.models.identity import Username
from app.models.opening_family import OpeningFamily
from app.models.position import Position
from app.schemas.theory import MistakeOut, TheoryMove
from app.services.swr import stale_while_revalidate

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


# PostgreSQL can read each game's plies in index order without sorting the
# entire library. SQLite computes the same pairs with a partitioned window.
ADJACENT_POSITIONS_POSTGRES = """
    SELECT gp.*, ug.user_color, ug.played_at
    FROM user_games ug
    JOIN LATERAL (
        SELECT gp.game_id, gp.ply, gp.position_id, gp.move_uci, gp.move_san,
               LAG(gp.ply) OVER game_order AS parent_ply,
               LAG(gp.position_id) OVER game_order AS parent_position_id
        FROM game_positions gp
        WHERE gp.game_id = ug.id
        WINDOW game_order AS (ORDER BY gp.ply)
    ) gp ON TRUE
"""

ADJACENT_POSITIONS_SQLITE = """
    SELECT gp.game_id, gp.ply, gp.position_id, gp.move_uci, gp.move_san,
           LAG(gp.ply) OVER game_order AS parent_ply,
           LAG(gp.position_id) OVER game_order AS parent_position_id,
           ug.user_color, ug.played_at
    FROM user_games ug
    JOIN game_positions gp ON gp.game_id = ug.id
    WINDOW game_order AS (PARTITION BY gp.game_id ORDER BY gp.ply)
"""


# Pair adjacent positions before joining engine depths. This keeps a popular
# position's evaluation rows from being copied to every appearance in a game.
_MISTAKES_QUERY = """
WITH
user_games AS (
    SELECT g.id, g.user_color, g.played_at
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
adjacent_positions AS (
__ADJACENT_GAME_POSITIONS__
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
off_book_decisions AS MATERIALIZED (
    SELECT d.game_id, d.ply, d.position_id, d.parent_position_id, d.move_uci, d.move_san, d.user_color
    FROM adjacent_positions d
    JOIN (SELECT DISTINCT from_position_id FROM master_top3) has_master
      ON has_master.from_position_id = d.parent_position_id
    LEFT JOIN master_top3 mt
      ON mt.from_position_id = d.parent_position_id AND mt.move_uci = d.move_uci
    WHERE mt.move_uci IS NULL
      AND d.ply > 0
      AND d.parent_ply = d.ply - 1
      AND d.move_uci IS NOT NULL
      AND (
          (d.user_color = 'white' AND d.ply % 2 = 1)
          OR (d.user_color = 'black' AND d.ply % 2 = 0)
      )
),
decision_positions AS MATERIALIZED (
    SELECT position_id FROM off_book_decisions
    UNION
    SELECT parent_position_id FROM off_book_decisions
),
-- One row per searched depth. An evaluation loss is the difference between two
-- positions, so both sides have to be compared at a depth they were both
-- searched to; see MAX_PAIR_DEPTH_GAP in engine_contract.py.
position_evals AS MATERIALIZED (
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
    JOIN decision_positions dp ON dp.position_id = ar.position_id
    WHERE ar.multipv_rank = 1
      AND ar.engine = 'stockfish-19'
      AND ar.engine_version = '19'
      AND ar.depth >= :min_depth
      AND (ar.eval_cp IS NOT NULL OR ar.eval_mate IS NOT NULL)
    UNION ALL
    SELECT po.position_id, po.white_result * 2000, NULL, NULL, NULL, po.white_result,
           1, NULL
    FROM position_outcomes po
    JOIN decision_positions dp ON dp.position_id = po.position_id
),
pair_candidates AS (
    SELECT d.parent_position_id, d.ply,
           COALESCE(d.move_san, d.move_uci) AS move_san, d.move_uci, d.user_color,
           parent.best_move_uci, parent.best_move_san,
           parent.eval_mate AS parent_eval_mate, child.eval_mate AS child_eval_mate,
           child.terminal_result AS child_terminal_result,
           CASE WHEN d.user_color = 'white' THEN parent.eval_cp - child.eval_cp
                ELSE child.eval_cp - parent.eval_cp END AS cp_loss,
           ROW_NUMBER() OVER (
               PARTITION BY d.game_id, d.ply
               ORDER BY parent.terminal_priority + child.terminal_priority DESC,
                        COALESCE(ABS(parent.eval_depth - child.eval_depth), 0),
                        COALESCE(parent.eval_depth, 0) + COALESCE(child.eval_depth, 0) DESC
           ) AS eval_rank
    FROM off_book_decisions d
    JOIN position_evals parent ON parent.position_id = d.parent_position_id
    JOIN position_evals child ON child.position_id = d.position_id
    WHERE parent.eval_depth IS NULL OR child.eval_depth IS NULL
       OR ABS(parent.eval_depth - child.eval_depth) <= :max_pair_depth_gap
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
"""


def _mistakes_statement(adjacent_positions: str):
    return text(
        _MISTAKES_QUERY.replace("__ADJACENT_GAME_POSITIONS__", adjacent_positions)
    ).bindparams(
        # asyncpg requires an explicit type for nullable integer parameters; without
        # it, PostgreSQL raises AmbiguousParameterError when family_pos_id is NULL.
        bindparam("username", type_=Username),
        bindparam("family_pos_id", type_=Integer()),
        bindparam("time_class", type_=Text()),
        bindparam("max_pair_depth_gap", type_=Integer()),
    )


_MISTAKES_SQL = _mistakes_statement(ADJACENT_POSITIONS_SQLITE)
_MISTAKES_POSTGRES_SQL = _mistakes_statement(ADJACENT_POSITIONS_POSTGRES)


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

    is_postgresql = session.bind is not None and session.bind.dialect.name == "postgresql"
    rows = await session.execute(
        _MISTAKES_POSTGRES_SQL if is_postgresql else _MISTAKES_SQL,
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

    # Resolve FENs only for mistakes that survived aggregation.
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
