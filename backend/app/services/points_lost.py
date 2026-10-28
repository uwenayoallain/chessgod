"""Where a player's games are actually lost, and whether openings are the reason.

Most players who feel they are losing in the opening are not, and learning
openings is the most expensive thing a player short of time can study. On the
first real corpus the first ten moves were 26% of the player's moves and 19% of
the winning chances they gave away; the middlegame was 71%, and seven tenths
of everything lost came from about one move in ten. This measures that for any
player so the answer is theirs, not a rule of thumb.

Loss is counted in *winning chances* (expected score, the curve Lichess uses
for accuracy), not centipawns. A pawn dropped at +8 changes nothing and a pawn
dropped at 0.0 changes a lot; summing centipawns counts them the same and makes
won endgames look like the player's weakest phase.

Measurements follow the drill queries exactly: trusted Stockfish 19 rows only,
scores capped at DECISIVE_CP with mates folded above it, and one measurement
per decision from the closest-matched, deepest pair of searches no further
apart than MAX_PAIR_DEPTH_GAP.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from math import exp

from sqlalchemy import Integer, Text, bindparam, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.engine_contract import MAX_PAIR_DEPTH_GAP, MIN_TRUSTED_DEPTH
from app.models.position import Position
from app.schemas.improvement import (
    LossKindOut,
    OpeningFixOut,
    OutOfOpeningOut,
    PhaseLossOut,
    PointsLostOut,
)

# Plies 1-20 are the opening, the same line `classify_pattern` and the Opening
# Quiz draw; after that, 13 points of pieces or fewer is an endgame, as in the
# coverage query.
OPENING_PLIES = 20
ENDGAME_MATERIAL = 13
# A move giving away this much expected score is a big error.
BIG_ERROR = 0.10
# A decision losing less than a pawn is a small slip, whatever its kind.
KIND_MIN_LOSS_CP = 100
# Neither side of the opening question is answered on fewer decisions.
MIN_PHASE_DECISIONS = 200
# The opening's share of loss against its share of moves.
LIGHTER_RATIO = 0.85
HEAVIER_RATIO = 1.15
# An opening fix is a move played at least this often, losing this much on average.
FIX_MIN_OCCURRENCES = 3
FIX_MIN_LOSS_CP = 100
FIX_LIMIT = 3

_KIND_LABELS = {
    "left_capturable": "Left something the opponent could take",
    "allowed_check": "Allowed a check that hurt",
    "missed_forcing": "Missed a capture or check of your own",
    "quiet": "Quiet moves that went wrong",
    "small": "Small slips, under a pawn each",
}

_USER_GAMES = """
user_games AS (
    SELECT g.id, g.user_color, g.opening_name
    FROM games g
    WHERE g.username = :username
      AND (:color = 'both' OR g.user_color = :color)
      AND CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END >= :min_user_rating
      AND (
          (:time_class = 'rapid_blitz' AND g.time_class IN ('rapid', 'blitz'))
          OR g.time_class = :time_class
      )
)"""

_DECISIONS_SQL = """
WITH
""" + _USER_GAMES + """,
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
           ar.best_move_uci, ar.best_move_san, 0 AS terminal_priority, ar.depth AS eval_depth
    FROM analysis_results ar
    WHERE ar.multipv_rank = 1
      AND ar.engine = 'stockfish-19'
      AND ar.engine_version = '19'
      AND ar.depth >= :min_depth
      AND (ar.eval_cp IS NOT NULL OR ar.eval_mate IS NOT NULL)
    UNION ALL
    SELECT position_id, white_result * 2000, NULL, NULL, 1, NULL
    FROM position_outcomes
),
evaluated_gp AS MATERIALIZED (
    SELECT gp.game_id, gp.ply, gp.position_id, gp.move_uci, gp.move_san,
           ug.user_color, ug.opening_name,
           pe.eval_cp, pe.best_move_uci, pe.best_move_san, pe.terminal_priority, pe.eval_depth
    FROM game_positions gp
    JOIN user_games ug ON ug.id = gp.game_id
    JOIN position_evals pe ON pe.position_id = gp.position_id
),
ranked AS (
    SELECT child.ply, child.user_color, child.opening_name,
           child.move_uci, child.move_san,
           parent.position_id AS parent_id,
           parent.move_uci AS previous_move_uci,
           parent.eval_cp AS before_cp,
           child.eval_cp AS after_cp,
           parent.best_move_uci, parent.best_move_san,
           child.best_move_san AS reply_san,
           ROW_NUMBER() OVER (
               PARTITION BY child.game_id, child.ply
               ORDER BY parent.terminal_priority + child.terminal_priority DESC,
                        CASE WHEN parent.eval_depth IS NULL OR child.eval_depth IS NULL THEN 0
                             ELSE ABS(parent.eval_depth - child.eval_depth) END ASC,
                        COALESCE(parent.eval_depth, 0) + COALESCE(child.eval_depth, 0) DESC
           ) AS eval_rank
    FROM evaluated_gp child
    JOIN evaluated_gp parent
      ON parent.game_id = child.game_id
     AND parent.ply = child.ply - 1
    WHERE child.move_uci IS NOT NULL
      AND (
          parent.eval_depth IS NULL
          OR child.eval_depth IS NULL
          OR ABS(parent.eval_depth - child.eval_depth) <= :max_pair_depth_gap
      )
      AND (
          (child.user_color = 'white' AND child.ply % 2 = 1)
          OR (child.user_color = 'black' AND child.ply % 2 = 0)
      )
)
SELECT r.ply, r.user_color, r.before_cp, r.after_cp, r.reply_san, r.best_move_san,
       CASE WHEN r.ply <= :opening_plies THEN r.parent_id END AS parent_id,
       CASE WHEN r.ply <= :opening_plies THEN r.move_uci END AS move_uci,
       CASE WHEN r.ply <= :opening_plies THEN r.move_san END AS move_san,
       CASE WHEN r.ply <= :opening_plies THEN r.best_move_uci END AS best_move_uci,
       CASE WHEN r.ply <= :opening_plies THEN r.previous_move_uci END AS previous_move_uci,
       CASE WHEN r.ply <= :opening_plies THEN r.opening_name END AS opening_name,
       CASE WHEN r.ply <= :opening_plies THEN NULL ELSE
           3 * (length(pieces) - length(replace(pieces, 'n', '')))
         + 3 * (length(pieces) - length(replace(pieces, 'b', '')))
         + 5 * (length(pieces) - length(replace(pieces, 'r', '')))
         + 9 * (length(pieces) - length(replace(pieces, 'q', '')))
       END AS material
FROM (
    SELECT ranked.*, lower(__BOARD_PLACEMENT__) AS pieces
    FROM ranked
    JOIN positions p ON p.id = ranked.parent_id
    WHERE ranked.eval_rank = 1
) r
"""

_TOTALS_SQL = """
WITH
""" + _USER_GAMES + """
SELECT COUNT(*) AS total,
       SUM(CASE WHEN gp.ply <= :opening_plies THEN 1 ELSE 0 END) AS opening
FROM game_positions gp
JOIN user_games ug ON ug.id = gp.game_id
WHERE gp.move_uci IS NOT NULL
  AND (
      (ug.user_color = 'white' AND gp.ply % 2 = 1)
      OR (ug.user_color = 'black' AND gp.ply % 2 = 0)
  )
"""


_AFTER_OPENING_SQL = """
WITH
""" + _USER_GAMES + """,
evals AS (
    SELECT ar.position_id, ar.depth,
           CASE
               WHEN ar.eval_cp > 1500 THEN 1500
               WHEN ar.eval_cp < -1500 THEN -1500
               WHEN ar.eval_cp IS NOT NULL THEN ar.eval_cp
               WHEN ar.eval_mate > 0 THEN 2000
               ELSE -2000
           END AS eval_cp,
           ROW_NUMBER() OVER (PARTITION BY ar.position_id ORDER BY ar.depth DESC) AS rank
    FROM analysis_results ar
    JOIN game_positions gp ON gp.position_id = ar.position_id AND gp.ply = :opening_plies
    JOIN user_games ug ON ug.id = gp.game_id
    WHERE ar.multipv_rank = 1
      AND ar.engine = 'stockfish-19'
      AND ar.engine_version = '19'
      AND ar.depth >= :min_depth
      AND (ar.eval_cp IS NOT NULL OR ar.eval_mate IS NOT NULL)
)
SELECT ug.user_color, g.user_result, e.eval_cp
FROM user_games ug
JOIN games g ON g.id = ug.id
JOIN game_positions gp ON gp.game_id = ug.id AND gp.ply = :opening_plies
JOIN evals e ON e.position_id = gp.position_id AND e.rank = 1
"""

# A pawn down after move 10 is an opening that went wrong.
WORSE_CP = -100
LEVEL_CP = 50


def out_of_opening(rows) -> list[OutOfOpeningOut]:
    """Per colour: where the opening leaves the player, and what that costs them."""
    by_color: dict[str, list[tuple[int, float]]] = {"white": [], "black": []}
    for color, result, eval_cp in rows:
        sign = 1 if color == "white" else -1
        score = {"win": 1.0, "draw": 0.5}.get(result, 0.0)
        by_color.setdefault(color, []).append((sign * int(eval_cp), score))
    out = []
    for color in ("white", "black"):
        games = by_color.get(color) or []
        if not games:
            continue
        worse = [score for cp, score in games if cp <= WORSE_CP]
        level = [score for cp, score in games if abs(cp) < LEVEL_CP]
        out.append(OutOfOpeningOut(
            color=color,
            games=len(games),
            average_cp=round(sum(cp for cp, _ in games) / len(games)),
            worse_share=round(len(worse) / len(games), 4),
            score_when_worse=round(sum(worse) / len(worse), 4) if worse else None,
            score_when_level=round(sum(level) / len(level), 4) if level else None,
        ))
    return out


def expected_score(cp: int) -> float:
    """The mover's expected score at `cp`, on the curve Lichess uses for accuracy."""

    return 1.0 / (1.0 + exp(-0.00368208 * cp))


def _is_capture(san: str | None) -> bool:
    return bool(san) and "x" in san


def _is_check(san: str | None) -> bool:
    return bool(san) and ("+" in san or "#" in san)


def loss_kind(loss_cp: int, reply_san: str | None, best_san: str | None) -> str:
    """Which forcing move gave the chances away, in the drill classifier's order.

    The same board facts `classify_pattern` reads: the opponent's best reply
    captures (hanging material), or checks (king safety), else the player's own
    best move was a capture or check they did not play.
    """

    if loss_cp < KIND_MIN_LOSS_CP:
        return "small"
    if _is_capture(reply_san):
        return "left_capturable"
    if _is_check(reply_san):
        return "allowed_check"
    if _is_capture(best_san) or _is_check(best_san):
        return "missed_forcing"
    return "quiet"


def _phase(ply: int, material: int | None) -> str:
    if ply <= OPENING_PLIES:
        return "opening"
    if material is not None and material <= ENDGAME_MATERIAL:
        return "endgame"
    return "middlegame"


@dataclass
class _Fix:
    occurrences: int = 0
    loss_cp: int = 0
    lost: float = 0.0
    played_san: str = ""
    best: Counter = field(default_factory=Counter)
    previous: Counter = field(default_factory=Counter)
    openings: Counter = field(default_factory=Counter)


def opening_verdict(phases: list[PhaseLossOut]) -> str:
    by_phase = {phase.phase: phase for phase in phases}
    opening = by_phase.get("opening")
    later = sum(
        phase.analyzed_decisions for phase in phases if phase.phase != "opening"
    )
    if (
        opening is None
        or opening.analyzed_decisions < MIN_PHASE_DECISIONS
        or later < MIN_PHASE_DECISIONS
        or not opening.share_of_moves
    ):
        return "insufficient"
    ratio = opening.share_of_loss / opening.share_of_moves
    if ratio < LIGHTER_RATIO:
        return "lighter"
    if ratio > HEAVIER_RATIO:
        return "heavier"
    return "even"


async def build_points_lost(
    session: AsyncSession,
    *,
    username: str,
    color: str,
    time_class: str,
    min_user_rating: int,
) -> PointsLostOut:
    postgres = session.bind is not None and session.bind.dialect.name == "postgresql"
    placement = (
        "split_part(p.fen, ' ', 1)" if postgres else "substr(p.fen, 1, instr(p.fen, ' ') - 1)"
    )
    sql = _DECISIONS_SQL.replace("__BOARD_PLACEMENT__", placement)
    params = {
        "username": username,
        "color": color,
        "time_class": time_class,
        "min_user_rating": min_user_rating,
        "min_depth": MIN_TRUSTED_DEPTH,
        "max_pair_depth_gap": MAX_PAIR_DEPTH_GAP,
        "opening_plies": OPENING_PLIES,
    }
    rows = (
        await session.execute(
            text(sql).bindparams(
                bindparam("time_class", type_=Text()),
                bindparam("max_pair_depth_gap", type_=Integer()),
            ),
            params,
        )
    ).mappings().all()
    totals = (
        await session.execute(
            text(_TOTALS_SQL).bindparams(bindparam("time_class", type_=Text())),
            {key: params[key] for key in ("username", "color", "time_class", "min_user_rating", "opening_plies")},
        )
    ).mappings().one()
    total_decisions = int(totals["total"] or 0)
    total_opening = int(totals["opening"] or 0)

    count: Counter[str] = Counter()
    lost: defaultdict[str, float] = defaultdict(float)
    kind_count: Counter[str] = Counter()
    kind_lost: defaultdict[str, float] = defaultdict(float)
    big_moves = 0
    big_lost = 0.0
    all_lost = 0.0
    fixes: dict[tuple[int, str], _Fix] = {}

    for row in rows:
        sign = 1 if row["user_color"] == "white" else -1
        before = sign * int(row["before_cp"])
        after = sign * int(row["after_cp"])
        chance = max(0.0, expected_score(before) - expected_score(after))
        loss_cp = max(0, before - after)
        phase = _phase(int(row["ply"]), row["material"])
        count[phase] += 1
        lost[phase] += chance
        all_lost += chance
        if chance >= BIG_ERROR:
            big_moves += 1
            big_lost += chance
        if phase == "opening":
            if row["parent_id"] is not None and row["move_uci"]:
                fix = fixes.setdefault((int(row["parent_id"]), row["move_uci"]), _Fix())
                fix.occurrences += 1
                fix.loss_cp += loss_cp
                fix.lost += chance
                fix.played_san = row["move_san"] or row["move_uci"]
                if row["best_move_uci"]:
                    fix.best[(row["best_move_uci"], row["best_move_san"])] += 1
                fix.previous[row["previous_move_uci"]] += 1
                if row["opening_name"]:
                    fix.openings[row["opening_name"]] += 1
        else:
            kind = loss_kind(loss_cp, row["reply_san"], row["best_move_san"])
            kind_count[kind] += 1
            kind_lost[kind] += chance

    analyzed = sum(count.values())
    # Each phase's loss is its average per analysed move times how many moves
    # the player made in it, so a library analysed mostly in one phase does not
    # make that phase look like the whole story. The opening's size is exact
    # (a ply count); the rest is split in the proportion analysed.
    later_analyzed = count["middlegame"] + count["endgame"]
    estimated = {
        "opening": float(total_opening),
        "middlegame": (total_decisions - total_opening) * count["middlegame"] / later_analyzed
        if later_analyzed else 0.0,
        "endgame": (total_decisions - total_opening) * count["endgame"] / later_analyzed
        if later_analyzed else 0.0,
    }
    average = {phase: lost[phase] / count[phase] if count[phase] else 0.0 for phase in estimated}
    weighted = {phase: average[phase] * estimated[phase] for phase in estimated}
    weighted_total = sum(weighted.values())
    moves_total = sum(estimated.values())
    phases = [
        PhaseLossOut(
            phase=phase,
            analyzed_decisions=count[phase],
            share_of_moves=round(estimated[phase] / moves_total, 4) if moves_total else 0.0,
            share_of_loss=round(weighted[phase] / weighted_total, 4) if weighted_total else 0.0,
            average_loss=round(average[phase], 4),
        )
        for phase in ("opening", "middlegame", "endgame")
    ]

    later_lost = sum(kind_lost.values())
    kinds = [
        LossKindOut(
            key=key,
            label=label,
            decisions=kind_count[key],
            share_of_loss=round(kind_lost[key] / later_lost, 4) if later_lost else 0.0,
        )
        for key, label in _KIND_LABELS.items()
    ]

    chosen = sorted(
        (
            (key, fix)
            for key, fix in fixes.items()
            if fix.occurrences >= FIX_MIN_OCCURRENCES
            and fix.loss_cp / fix.occurrences >= FIX_MIN_LOSS_CP
            and fix.best
            and fix.best.most_common(1)[0][0][0] != key[1]
        ),
        key=lambda item: item[1].lost,
        reverse=True,
    )[:FIX_LIMIT]
    fens = {}
    if chosen:
        fens = dict(
            (
                await session.execute(
                    select(Position.id, Position.fen).where(
                        Position.id.in_([key[0] for key, _ in chosen])
                    )
                )
            ).all()
        )
    opening_fixes = []
    for (position_id, move_uci), fix in chosen:
        fen = fens.get(position_id)
        if fen is None:
            continue
        (best_uci, best_san), _ = fix.best.most_common(1)[0]
        opening_fixes.append(
            OpeningFixOut(
                position_id=position_id,
                fen=fen,
                last_move_uci=fix.previous.most_common(1)[0][0],
                side_to_move="white" if fen.split(" ")[1] == "w" else "black",
                opening_name=fix.openings.most_common(1)[0][0] if fix.openings else None,
                played_san=fix.played_san,
                played_uci=move_uci,
                best_san=best_san or best_uci,
                best_uci=best_uci,
                occurrences=fix.occurrences,
                average_loss_cp=round(fix.loss_cp / fix.occurrences),
            )
        )

    after_opening = (
        await session.execute(
            text(_AFTER_OPENING_SQL).bindparams(bindparam("time_class", type_=Text())),
            {key: params[key] for key in (
                "username", "color", "time_class", "min_user_rating", "opening_plies", "min_depth",
            )},
        )
    ).all()

    return PointsLostOut(
        username=username,
        color=color,
        time_class=time_class,
        min_user_rating=min_user_rating,
        analyzed_decisions=analyzed,
        total_decisions=total_decisions,
        phases=phases,
        big_error_threshold=BIG_ERROR,
        big_error_share_of_moves=round(big_moves / analyzed, 4) if analyzed else 0.0,
        big_error_share_of_loss=round(big_lost / all_lost, 4) if all_lost else 0.0,
        kinds=kinds,
        opening_fixes=opening_fixes,
        opening_verdict=opening_verdict(phases),
        out_of_opening=out_of_opening(after_opening),
    )
