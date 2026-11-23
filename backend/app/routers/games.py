from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from itertools import islice
from typing import Annotated

import chess
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import (
    Integer,
    all_,
    and_,
    any_,
    case,
    cast,
    func,
    literal,
    literal_column,
    null,
    or_,
    select,
    tuple_,
    union_all,
)
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.database import _async_engine_for, get_db
from app.engine_contract import (
    ENGINE_NAME,
    ENGINE_VERSION,
    GAME_REVIEW_DEPTH,
    MAX_PAIR_DEPTH_GAP,
)
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.analysis import AnalysisResult
from app.models.position import Position
from app.models.position_outcome import PositionOutcome
from app.services import threats
from app.services.cache import get_shared_cache
from app.utils.fen import normalize_fen
from app.services.game_scope import (
    player_rating_floor,
    standard_rules_condition,
    time_class_condition,
    user_rating_condition,
)
from app.schemas.game import (
    AnalysisQueueExclusions,
    ColorStats,
    GameListOut,
    GameOut,
    GameStatsOut,
    OpeningDetailStat,
    OpeningGroupListOut,
    OpeningGroupOut,
    OpeningPreviewOut,
    OpeningStat,
    TimeClassStats,
)

router = APIRouter()
logger = logging.getLogger(__name__)

_COVERAGE_TTL_SECONDS = 300.0  # a progress label; imports clear it
_RECENT_DECISION_OVERFETCH = 16
_MIN_RECENT_DECISIONS = 200
# How many games one page of the walk covers. Adaptive: see collect_pairs.
_GAME_CHUNK_START = 32
_GAME_CHUNK_MAX = 512
# Slices of the player's history the queue rotates through, so coverage does
# not pile into the newest games and leave every older window untestable.
_HISTORY_ERAS = 4
# The newest sitting is searched before the era rotation: the games played
# within this long of the newest one, at most this many.
_FRESH_WINDOW = timedelta(hours=12)
_FRESH_GAMES = 6
_FRESH_RECENT = timedelta(days=2)
# How many growing windows a fallback reads before giving up on a full batch.
_FALLBACK_READS = 6
# How long the analysis queue's pool of decision pairs is reused, and how many
# pairs with work (as a multiple of the request) it must hold to be reused.
#
# An hour, not ten minutes. The pool does not go stale the way a cached answer
# does: every request re-checks its pairs' depths, so finished work is never
# handed out again, and an import clears the pool outright. What the TTL still
# guards is work that appears any other way -- a position studied on the board
# past the review band -- which is rare. Meanwhile each expiry made the request
# that found it rebuild the whole pool inline: ~3s on a quiet machine, 6-12s
# with another project's batch jobs at load 10-16, and past the crawler's old
# 30s timeout six times in one night, each costing it minutes of backoff.
_POOL_TTL_SECONDS = 3600.0
_POOL_REFILL_FACTOR = 4
# How long a pool that came back short of work is kept before walking again.
_POOL_SHORT_REST_SECONDS = 900.0
# How long a pool stays readable at all. Past _POOL_TTL_SECONDS it is still
# served, because each request re-checks its pairs' depths, and one walk
# replaces it behind the request instead of in front of it.
_POOL_KEEP_SECONDS = 86_400.0
# How many already-read pairs a page read leaves out in SQL (see read_page_pairs).
_SEEN_PAIRS_IN_SQL = 4000
# The one walk in progress per pool, so a second request for the same scope
# joins it instead of walking the library again beside it.
_pool_flights: dict[str, asyncio.Task[list["_DecisionPairTarget"]]] = {}
# How many Blunder Check and Punish candidates one read checks for stored
# second and third lines (see trainer_multipv_fens).
_TRAINER_BATCH = 200


@dataclass(frozen=True)
class _DecisionPairTarget:
    parent_position_id: int
    parent_fen: str
    child_position_id: int
    child_fen: str
    ply: int
    # How long the player took over this move, when the game recorded clocks.
    think_seconds: float | None = None


# A decision this early is opening play by ply alone, before any material test.
_OPENING_MAX_PLY = 20
# Non-pawn material at or below which the position is an endgame, counting
# knights and bishops as 3, rooks 5, queens 9. Matches `_analysis_phase`.
_ENDGAME_MATERIAL = 13
# The buckets the queue rotates through, and the shares a page is split into.
_PHASES = ("endgame", "middlegame", "opening")
# The median think time over this library's clocked decisions. Used as the
# neutral stand-in when a game recorded no clocks, so those decisions neither
# jump the queue nor sink to the bottom of it.
_MEDIAN_THINK_SECONDS = 3.0


def _analysis_phase(ply: int, fen: str) -> str:
    if ply <= _OPENING_MAX_PLY:
        return "opening"
    placement = fen.split()[0].lower()
    non_pawn_value = sum(placement.count(piece) * value for piece, value in (("n", 3), ("b", 3), ("r", 5), ("q", 9)))
    return "endgame" if non_pawn_value <= 13 else "middlegame"


def _board_phase(fen_column, ply_column, *, dialect: str):
    """The game phase of a decision, as SQL rather than as Python.

    `_analysis_phase` decides this in Python, but by then the candidate pool is
    already chosen, and the pool is where the bias lives. Ordering a page by
    ply and keeping the first N gives the opening and early middlegame of the
    newest game or two, so the phase rotation downstream has nothing to rotate
    to. Computing the phase in the query lets each phase be given its own share
    of the page.

    Mirrors `_COVERAGE_SQL`: ply alone before the opening ends, then non-pawn
    material, counted by deleting each piece letter from the board placement and
    measuring how much shorter the string got.
    """

    if dialect == "postgresql":
        placement = func.split_part(fen_column, " ", 1)
    else:
        placement = func.substr(fen_column, 1, func.instr(fen_column, " ") - 1)
    pieces = func.lower(placement)
    material = sum(
        value * (func.length(pieces) - func.length(func.replace(pieces, piece, "")))
        for piece, value in (("n", 3), ("b", 3), ("r", 5), ("q", 9))
    )
    return case(
        (ply_column <= _OPENING_MAX_PLY, "opening"),
        (material <= _ENDGAME_MATERIAL, "endgame"),
        else_="middlegame",
    )


@lru_cache(maxsize=32_768)
def _is_storable_fen(fen: str) -> bool:
    """Whether the evaluations endpoint could store a search of this position.

    Mirrors the FEN half of AnalysisEvaluationItemIn.validate_chess_analysis: a
    four- or six-field FEN that parses but fails python-chess validity is
    rejected with 422, so offering it only burns an engine search plus two
    uploads every batch forever: the queue re-offers a position until it is
    analysed, and one of these can never become analysed. Seen in the wild:
    stale castling rights (`kq` on a board whose king has left e8), which the
    engine searches happily and the validator refuses.

    Remembered, because the answer for a FEN never changes and the queue asks
    it of the same pool again and again: a request for a browser-sized batch
    set up 25,000 boards to ask it, which was 2.4s of the 2.6s it took with
    the pool already cached, all of it holding the event loop.
    """
    parts = fen.split()
    if len(fen) > 120 or len(parts) not in (4, 6):
        return False
    try:
        board = chess.Board(fen if len(parts) == 6 else f"{fen} 0 1")
    except ValueError:
        return False
    return board.is_valid()


def _dialect_name(session: AsyncSession) -> str:
    return session.bind.dialect.name if session.bind is not None else "postgresql"


def _member_of(column, values, *, dialect: str):
    """`column` is one of `values`, as one array parameter on PostgreSQL.

    An IN list is a bind parameter per value, so a statement's text changes
    with the count and each count is parsed and planned as a statement nobody
    has seen before. One array keeps the text the same whatever it holds.
    Other dialects (the tests' SQLite) have no arrays and keep the list.
    """

    values = list(values)
    if dialect == "postgresql":
        return column == any_(literal(values, type_=PG_ARRAY(column.type)))
    return column.in_(values)


def _not_member_of(column, values, *, dialect: str):
    """`column` is none of `values`; see `_member_of`."""

    values = list(values)
    if dialect == "postgresql":
        return column != all_(literal(values, type_=PG_ARRAY(column.type)))
    return column.not_in(values)


def _pair_not_among(parent_column, child_column, pairs, *, dialect: str):
    """`(parent, child)` is none of `pairs`, as an anti-join on PostgreSQL.

    This was a row-wise NOT IN over up to 4,000 pairs: 8,000 bind parameters
    and a filter the planner rebuilt for every count, measured at up to 116ms
    of planning for a read that then ran in a few. Two arrays unnested side by
    side are the same pairs behind one statement text and a hashed anti-join.
    """

    pairs = list(pairs)
    if dialect == "postgresql":
        seen = (
            func.unnest(
                literal([parent for parent, _ in pairs], type_=PG_ARRAY(parent_column.type)),
                literal([child for _, child in pairs], type_=PG_ARRAY(child_column.type)),
            )
            .table_valued("parent_id", "child_id")
            .render_derived(name="seen_pairs")
        )
        return ~(
            select(literal_column("1"))
            .select_from(seen)
            .where(seen.c.parent_id == parent_column, seen.c.child_id == child_column)
            .exists()
        )
    return tuple_(parent_column, child_column).not_in(pairs)


def _pair_work(
    pair: _DecisionPairTarget,
    *,
    depth_by_position: dict[int, int],
    exact_position_ids: set[int],
    min_depth: int,
    review_band: bool = False,
) -> list[tuple[str, int]]:
    """The searches this decision still needs, as (fen, depth) targets.

    An evaluation loss is the difference between two searches, so a decision can
    only be graded once both of its positions have been searched to a depth they
    share. The pair is brought to the deepest evidence either side already
    carries: a parent someone studied on the board at depth 30 is not re-run
    shallower (a shallower result would be discarded by the browser's own
    depth-max cache and the pair would stay ungradeable forever); the child is
    searched to depth 30 instead, which also makes the measurement better.

    `review_band` turns that round for a client with no such cache (the Node
    crawler): every side is brought to the review depth instead, so a side
    studied at 34 is searched once more at 22 rather than its partner at 34.
    Rows are stored per depth, so the 22 lands beside the 34 and the pair is
    graded at 22. A depth-34 search on one throttled engine timed out, was set
    aside for hours and came back to time out again; those were all the work
    the crawler had left. `depth_by_position` must then hold each position's
    in-band depth where it has one (`load_depths` does).
    """

    sides = (
        (pair.parent_position_id, pair.parent_fen),
        (pair.child_position_id, pair.child_fen),
    )
    # A finished game is exact rather than searched: it needs no work and
    # constrains no depth. A position the evaluations endpoint cannot store
    # needs no search either: offering it burns an engine job every batch
    # while the pair stays ungradeable forever (see _is_storable_fen). The
    # storable side of a half-bad pair is still offered: its search stands on
    # its own in every other decision that reaches the position.
    searchable = [
        (pid, fen) for pid, fen in sides
        if pid not in exact_position_ids and _is_storable_fen(fen)
    ]
    known = [depth_by_position[pid] for pid, _ in searchable if pid in depth_by_position]
    target = min_depth if review_band else max([min_depth, *known])
    work: list[tuple[str, int]] = []
    for position_id, fen in searchable:
        depth = depth_by_position.get(position_id)
        if depth is not None and abs(depth - target) <= MAX_PAIR_DEPTH_GAP:
            continue
        work.append((fen, target))
    return work


def _phase_balanced_pair_fens(
    pairs: list[_DecisionPairTarget],
    *,
    depth_by_position: dict[int, int],
    exact_position_ids: set[int] | None = None,
    min_depth: int,
    limit: int,
    review_band: bool = False,
) -> tuple[list[str], dict[str, int], dict[str, int]]:
    """Select complete decision pairs while rotating through game phases."""

    exact_position_ids = exact_position_ids or set()

    def work_for(pair: _DecisionPairTarget) -> list[tuple[str, int]]:
        return _pair_work(
            pair,
            depth_by_position=depth_by_position,
            exact_position_ids=exact_position_ids,
            min_depth=min_depth,
            review_band=review_band,
        )

    buckets = {phase: [] for phase in ("endgame", "middlegame", "opening")}
    for pair in pairs:
        buckets[_analysis_phase(pair.ply, pair.parent_fen)].append(pair)

    # Finish half-evaluated decisions first within each phase: one engine job
    # can make a usable lesson instead of leaving another half-pair behind.
    # Python's stable sort preserves recency among equally costly pairs.
    for phase_pairs in buckets.values():
        phase_pairs.sort(key=lambda pair: len(work_for(pair)) or 3)

    # Past the opening, positions do not repeat, so there is no recurrence to
    # order by, but there is the clock, which costs no engine time and turns
    # out to say a great deal. Measured over 210 decisions from this library,
    # searched at depth 22: moves played in under a second were wrong 8% of the
    # time, the broad middle 23-32%, and moves the player thought about for 15
    # seconds or more were wrong 53% of the time and lost 200cp or more 41% of
    # the time. That is the opposite of the usual assumption that rushed moves
    # are the blunders: a fast move is usually a forced or obvious one, while a
    # long think marks a position the player found genuinely hard, which is
    # where they err, and exactly the decision worth a lesson. The tail samples
    # are small (17 long thinks, 25 sub-second), so this orders work rather than
    # discarding any: every decision is still crawled, the informative ones just
    # come first.
    for phase in ("middlegame", "endgame"):
        buckets[phase].sort(
            key=lambda pair: (
                len(work_for(pair)) or 3,
                # Unclocked games sort with the median rather than last: a
                # missing clock is not evidence the move was easy.
                -(pair.think_seconds if pair.think_seconds is not None else _MEDIAN_THINK_SECONDS),
            )
        )

    # The opening bucket keeps recency. It was ordered by recurrence for a
    # while (how many of the player's decisions one search unlocks), which
    # multiplied the *instances* a batch covered (+28 to +81 in one measurement)
    # while unlocking the same number of distinct decisions (+10 either way).
    # Instances are not lessons: the drill pipeline groups by position, so fifty
    # repetitions of one opening position are one lesson. Worse, the positions
    # it steered toward were the player's own main lines, which are memorised:
    # measured over the corpus it built, recurrence-covered opening decisions
    # were mistakes 4.7% of the time against 21.0% for the rest of the queue.
    # See docs/analysis-priority-findings.md.

    cursors = dict.fromkeys(buckets, 0)
    selected_pair_counts = dict.fromkeys(buckets, 0)
    selected: list[str] = []
    selected_fens: set[str] = set()
    depth_targets: dict[str, int] = {}
    while len(selected) < limit:
        progressed = False
        for phase, phase_pairs in buckets.items():
            while cursors[phase] < len(phase_pairs):
                pair = phase_pairs[cursors[phase]]
                cursors[phase] += 1
                pending = [
                    (fen, depth) for fen, depth in work_for(pair) if fen not in selected_fens
                ]
                missing = [fen for fen, _ in pending]
                if not missing:
                    continue
                # Do not split a fully missing parent/child pair merely to fill
                # the last slot of an odd-sized request.
                if len(missing) > limit - len(selected):
                    continue
                selected.extend(missing)
                selected_fens.update(missing)
                depth_targets.update(dict(pending))
                selected_pair_counts[phase] += 1
                progressed = True
                break
        if not progressed:
            break
    return selected, selected_pair_counts, depth_targets


def build_game_filters(
    username: str,
    time_class: str | None = None,
    user_result: str | None = None,
    color: str | None = None,
    opening_name: str | None = None,
    eco: str | None = None,
) -> list:
    filters = [Game.username == username]
    time_filter = time_class_condition(Game.time_class, time_class)
    if time_filter is not None:
        filters.append(time_filter)

    if user_result:
        filters.append(Game.user_result == user_result)
    if color and color != "both":
        filters.append(Game.user_color == color)
    if opening_name:
        if opening_name == "Unknown":
            filters.append(or_(Game.opening_name.is_(None), Game.opening_name == ""))
        else:
            filters.append(Game.opening_name == opening_name)
    if eco:
        filters.append(Game.eco == eco)
    return filters


@router.get("", response_model=GameListOut)
async def list_games(
    username: str = Query(...),
    time_class: str | None = None,
    user_result: str | None = None,
    color: str = Query("both", pattern="^(white|black|both)$"),
    opening_name: str | None = None,
    eco: str | None = None,
    fen: str | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    per_page: Annotated[int, Query(ge=1, le=100)] = 50,
    session: AsyncSession = Depends(get_db),
) -> GameListOut:
    filters = build_game_filters(
        username=username,
        time_class=time_class,
        user_result=user_result,
        color=color,
        opening_name=opening_name,
        eco=eco,
    )
    if fen:
        # The position is looked up once and each game is then asked whether
        # it visits it. Joining game_positions and positions into the listing
        # multiplied every game by its visits, so the page had to be grouped
        # back down to games and the count taken over distinct ids: 186ms
        # against 1.63ms for the same page.
        position_id = await session.scalar(select(Position.id).where(Position.fen == fen))
        if position_id is None:
            return GameListOut(games=[], total=0, page=page, per_page=per_page)
        filters.append(
            select(GamePosition.id)
            .where(GamePosition.game_id == Game.id, GamePosition.position_id == position_id)
            .exists()
        )

    # One row per game already, so there is nothing to group or de-duplicate.
    total = await session.scalar(select(func.count()).select_from(Game).where(*filters))
    page_games = (
        await session.execute(
            select(Game)
            .where(*filters)
            .order_by(Game.played_at.desc(), Game.id.desc())
            .offset((page - 1) * per_page)
            .limit(per_page)
        )
    ).scalars().all()
    if not page_games:
        return GameListOut(games=[], total=total or 0, page=page, per_page=per_page)

    dialect = _dialect_name(session)
    analyzed_result = await session.execute(
        select(Game.id).where(
            _member_of(Game.id, [game.id for game in page_games], dialect=dialect),
            select(GamePosition.id)
            .join(AnalysisResult, AnalysisResult.position_id == GamePosition.position_id)
            .where(
                GamePosition.game_id == Game.id,
                AnalysisResult.engine == ENGINE_NAME,
                AnalysisResult.engine_version == ENGINE_VERSION,
                AnalysisResult.depth >= 20,
                AnalysisResult.multipv_rank == 1,
            )
            .exists(),
        )
    )
    analyzed_game_ids = set(analyzed_result.scalars().all())
    games = [
        GameOut.model_validate(game).model_copy(update={"has_analysis": game.id in analyzed_game_ids})
        for game in page_games
    ]
    return GameListOut(games=games, total=total or 0, page=page, per_page=per_page)


@router.get("/stats", response_model=GameStatsOut)
async def game_stats(
    username: str = Query(...),
    time_class: str | None = None,
    session: AsyncSession = Depends(get_db),
) -> GameStatsOut:
    filters = [Game.username == username]
    time_filter = time_class_condition(Game.time_class, time_class)
    if time_filter is not None:
        filters.append(time_filter)

    # One scan at the finest grain the answer needs, folded four ways here.
    # The totals, the colours, the time classes and the openings were four
    # scans of the same games (168ms together); a player has a few hundred
    # (colour, time class, opening) groups, which is nothing to add up.
    rows = (
        await session.execute(
            select(
                Game.user_color,
                Game.time_class,
                Game.opening_name,
                func.count(Game.id),
                func.sum(case((Game.user_result == "win", 1), else_=0)),
                func.sum(case((Game.user_result == "loss", 1), else_=0)),
                func.sum(case((Game.user_result == "draw", 1), else_=0)),
            )
            .where(*filters)
            .group_by(Game.user_color, Game.time_class, Game.opening_name)
        )
    ).all()

    total_games = 0
    total_wins = 0
    color_totals = {"white": [0, 0, 0], "black": [0, 0, 0]}
    class_totals: dict[str, list[int]] = {}
    # Keyed on the stored name, so games with no opening stay one group of
    # their own and are only labelled "Unknown" on the way out.
    opening_totals: dict[str | None, int] = {}
    for user_color, time_class_name, opening, games, wins, losses, draws in rows:
        games, wins, losses, draws = int(games), int(wins or 0), int(losses or 0), int(draws or 0)
        total_games += games
        total_wins += wins
        if user_color in color_totals:
            by_result = color_totals[user_color]
            by_result[0] += wins
            by_result[1] += losses
            by_result[2] += draws
        by_class = class_totals.setdefault(time_class_name, [0, 0, 0, 0])
        by_class[0] += games
        by_class[1] += wins
        by_class[2] += losses
        by_class[3] += draws
        opening_totals[opening] = opening_totals.get(opening, 0) + games

    if not total_games:
        return GameStatsOut(
            by_color={"white": ColorStats(), "black": ColorStats()},
            by_time_class={},
            by_opening=[],
        )

    top_openings = sorted(
        (("Unknown" if opening is None else opening, games) for opening, games in opening_totals.items()),
        key=lambda item: (-item[1], item[0]),
    )[:10]
    return GameStatsOut(
        total_games=total_games,
        win_rate=round(total_wins / total_games, 4),
        by_color={
            color: ColorStats(wins=wins, losses=losses, draws=draws)
            for color, (wins, losses, draws) in color_totals.items()
        },
        by_time_class={
            name: TimeClassStats(
                games=games,
                wins=wins,
                losses=losses,
                draws=draws,
                win_rate=round(wins / games, 4) if games else 0.0,
            )
            for name, (games, wins, losses, draws) in class_totals.items()
        },
        by_opening=[OpeningStat(opening_name=name, games=games) for name, games in top_openings],
    )


@router.get("/openings", response_model=list[OpeningDetailStat])
async def game_openings(
    username: str = Query(...),
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    session: AsyncSession = Depends(get_db),
) -> list[OpeningDetailStat]:
    filters = build_game_filters(username=username, color=color, time_class=time_class)

    opening_label = func.coalesce(Game.opening_name, "Unknown")
    opponent_rating = case(
        (Game.user_color == "white", Game.black_rating),
        else_=Game.white_rating,
    )
    rows = await session.execute(
        select(
            func.min(Game.eco),
            opening_label,
            func.count(Game.id),
            func.sum(case((Game.user_result == "win", 1), else_=0)),
            func.sum(case((Game.user_result == "loss", 1), else_=0)),
            func.sum(case((Game.user_result == "draw", 1), else_=0)),
            func.avg(opponent_rating),
        )
        .where(*filters)
        .group_by(Game.opening_name)
        .order_by(func.count(Game.id).desc())
    )

    return [
        OpeningDetailStat(
            eco=eco,
            opening_name=opening_name,
            game_count=count,
            wins=wins or 0,
            losses=losses or 0,
            draws=draws or 0,
            win_rate=round((wins or 0) / count, 4) if count else 0.0,
            avg_rating=round(avg_rating, 1) if avg_rating is not None else None,
        )
        for eco, opening_name, count, wins, losses, draws, avg_rating in rows.all()
    ]


@router.get("/opening-groups", response_model=OpeningGroupListOut)
async def game_opening_groups(
    username: str = Query(...),
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    per_page: Annotated[int, Query(ge=1, le=100)] = 20,
    session: AsyncSession = Depends(get_db),
) -> OpeningGroupListOut:
    filters = build_game_filters(username=username, color=color, time_class=time_class)
    opening_label = func.coalesce(Game.opening_name, "Unknown")
    grouped_stmt = (
        select(
            Game.eco,
            opening_label.label("opening_label"),
            func.count(Game.id).label("game_count"),
            func.sum(case((Game.user_result == "win", 1), else_=0)).label("wins"),
            func.sum(case((Game.user_result == "loss", 1), else_=0)).label("losses"),
            func.sum(case((Game.user_result == "draw", 1), else_=0)).label("draws"),
            func.max(Game.played_at).label("latest_played_at"),
        )
        .where(*filters)
        .group_by(Game.eco, Game.opening_name)
        .subquery()
    )
    total = await session.scalar(select(func.count()).select_from(grouped_stmt))
    rows = await session.execute(
        select(
            grouped_stmt.c.eco,
            grouped_stmt.c.opening_label,
            grouped_stmt.c.game_count,
            grouped_stmt.c.wins,
            grouped_stmt.c.losses,
            grouped_stmt.c.draws,
            grouped_stmt.c.latest_played_at,
            func.max(Game.id),
        )
        .join(
            Game,
            (Game.eco.is_not_distinct_from(grouped_stmt.c.eco))
            & (func.coalesce(Game.opening_name, "Unknown") == grouped_stmt.c.opening_label)
            & (Game.played_at == grouped_stmt.c.latest_played_at),
        )
        .where(*filters)
        .group_by(
            grouped_stmt.c.eco,
            grouped_stmt.c.opening_label,
            grouped_stmt.c.game_count,
            grouped_stmt.c.wins,
            grouped_stmt.c.losses,
            grouped_stmt.c.draws,
            grouped_stmt.c.latest_played_at,
        )
        # Frequency first, recency only as the tie-break. Ordered by recency the
        # list opened with whatever was played last, so a line played once sat
        # above an opening played hundreds of times, and since the list is
        # paginated, the openings that actually describe a player's repertoire
        # could be pages deep. One-game rows now fall to the end, where they
        # belong.
        .order_by(
            grouped_stmt.c.game_count.desc(),
            grouped_stmt.c.latest_played_at.desc(),
            grouped_stmt.c.opening_label.asc(),
        )
        .offset((page - 1) * per_page)
        .limit(per_page)
    )

    return OpeningGroupListOut(
        openings=[
            OpeningGroupOut(
                eco=eco,
                opening_name=opening_name,
                game_count=game_count,
                wins=wins or 0,
                losses=losses or 0,
                draws=draws or 0,
                latest_played_at=latest_played_at,
                representative_game_id=representative_game_id,
            )
            for (
                eco,
                opening_name,
                game_count,
                wins,
                losses,
                draws,
                latest_played_at,
                representative_game_id,
            ) in rows.all()
        ],
        total=total or 0,
        page=page,
        per_page=per_page,
    )


@router.get("/opening-preview", response_model=OpeningPreviewOut)
async def get_opening_preview(
    username: str = Query(...),
    opening_name: str = Query(...),
    eco: str | None = None,
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    session: AsyncSession = Depends(get_db),
) -> OpeningPreviewOut:
    filters = build_game_filters(
        username=username,
        color=color,
        time_class=time_class,
        opening_name=opening_name,
        eco=eco,
    )
    game = await session.scalar(
        select(Game)
        .where(*filters)
        .order_by(Game.played_at.desc(), Game.id.desc())
        .limit(1)
    )
    if game is None:
        raise HTTPException(status_code=404, detail="Opening preview not found")

    return OpeningPreviewOut(
        eco=game.eco,
        opening_name=game.opening_name or opening_name,
        representative_game=GameOut.model_validate(game),
    )


@dataclass(frozen=True)
class _QueueScope:
    """Whose queue this is and how it is filtered: what a pool is good for."""

    username: str
    color: str
    time_class: str | None
    min_depth: int
    min_user_rating: int
    # Bring pairs to the review depth rather than to their deepest side.
    review_band: bool
    excluded_fens: tuple[str, ...]
    # How many decision pairs a walk of the library aims to hold.
    pair_target: int

    def game_filters(self) -> list:
        filters = [
            Game.username == self.username,
            user_rating_condition(Game, self.min_user_rating),
            standard_rules_condition(Game),
        ]
        if self.color != "both":
            filters.append(Game.user_color == self.color)
        time_filter = time_class_condition(Game.time_class, self.time_class)
        if time_filter is not None:
            filters.append(time_filter)
        return filters

    def pool_base(self) -> str:
        # The walk leaves the excluded positions out, so a pool is only good
        # for the exclusions it was built under. The crawler's set changes only
        # when a search times out, so it still reuses its pool batch after batch.
        exclusion_digest = (
            hashlib.sha1("\n".join(sorted(self.excluded_fens)).encode()).hexdigest()[:16]
            if self.excluded_fens else "none"
        )
        # Under `queue-pool:v2:{username}:`, the prefix an import drops.
        return (
            f"queue-pool:v2:{self.username}:{self.color}:{self.time_class}:{self.min_depth}:"
            f"{self.min_user_rating}:{self.pair_target}:{exclusion_digest}:"
            f"{'band' if self.review_band else 'deep'}:dated"
        )


class _QueueReader:
    """The analysis queue's reads for one scope, on one session.

    A class rather than closures inside the endpoint so the walk of the
    library can run on a session of its own, behind the request that asked for
    it or shared by several of them (see `_pool_flight`).
    """

    def __init__(self, session: AsyncSession, scope: _QueueScope) -> None:
        self.session = session
        self.scope = scope
        self.dialect = _dialect_name(session)
        self.filters = scope.game_filters()
        self.child_gp = aliased(GamePosition)
        self.parent_gp = aliased(GamePosition)
        self.child_position = aliased(Position)
        self.parent_position = aliased(Position)

    def is_resolved(self, position_id):
        return or_(
            select(AnalysisResult.id).where(
                AnalysisResult.position_id == position_id,
                AnalysisResult.engine == ENGINE_NAME,
                AnalysisResult.engine_version == ENGINE_VERSION,
                AnalysisResult.depth >= self.scope.min_depth,
                AnalysisResult.multipv_rank == 1,
            ).exists(),
            select(PositionOutcome.position_id).where(PositionOutcome.position_id == position_id).exists(),
        )

    def is_deep_outlier(self, position_id):
        # A position searched deeper than the review band: someone studied it
        # on the board. Its partner cannot be differenced against it at the
        # review depth, so the pair is work even though both sides are
        # "analyzed". Crawled positions never hit this, so the extra pairs this
        # admits are bounded by how much the player has studied by hand.
        return select(AnalysisResult.id).where(
            AnalysisResult.position_id == position_id,
            AnalysisResult.engine == ENGINE_NAME,
            AnalysisResult.engine_version == ENGINE_VERSION,
            AnalysisResult.depth > self.scope.min_depth + MAX_PAIR_DEPTH_GAP,
            AnalysisResult.multipv_rank == 1,
        ).exists()

    async def coverage_counts(self) -> tuple[int, int]:
        """How many of the player's positions there are, and how many are resolved.

        The counts scan every game_position of the user (seconds at millions
        of rows) and only exist for the progress label, so they are cached
        briefly: the browser autopilot polls this endpoint every 30s.
        """

        scope = self.scope
        cache = get_shared_cache()
        cache_key = await cache.versioned_key(
            f"coverage:v3:{scope.username}:{scope.color}:{scope.time_class}:"
            f"{scope.min_depth}:{scope.min_user_rating}"
        )
        cached_counts = await cache.get_json(cache_key)
        if cached_counts is not None:
            return int(cached_counts[0]), int(cached_counts[1])
        analyzed_positions = (
            select(AnalysisResult.position_id)
            .where(
                AnalysisResult.engine == ENGINE_NAME,
                AnalysisResult.engine_version == ENGINE_VERSION,
                AnalysisResult.depth >= scope.min_depth,
                AnalysisResult.multipv_rank == 1,
            )
            .union(select(PositionOutcome.position_id))
            .cte("analyzed_positions")
        )
        candidate_ids = (
            select(GamePosition.position_id)
            .join(Game, Game.id == GamePosition.game_id)
            .where(*self.filters)
            .distinct()
            .subquery()
        )
        count_row = await self.session.execute(
            select(
                func.count().label("candidate_count"),
                func.count(analyzed_positions.c.position_id).label("analyzed_count"),
            )
            .select_from(candidate_ids)
            .outerjoin(
                analyzed_positions,
                analyzed_positions.c.position_id == candidate_ids.c.position_id,
            )
        )
        candidate_count, analyzed_count = count_row.one()
        candidate_count = int(candidate_count or 0)
        analyzed_count = int(analyzed_count or 0)
        await cache.set_json(
            cache_key,
            [candidate_count, analyzed_count],
            ttl_seconds=_COVERAGE_TTL_SECONDS,
        )
        return candidate_count, analyzed_count

    async def read_page_pairs(
        self,
        game_ids: list[int],
        per_phase: int,
        remaining: int,
        *,
        seen_pairs: dict[tuple[int, int], None],
    ):
        """One read of a page: up to `per_phase` unseen decisions per phase."""

        child_gp, parent_gp = self.child_gp, self.parent_gp
        child_position, parent_position = self.child_position, self.parent_position
        phase = _board_phase(parent_position.fen, child_gp.ply, dialect=self.dialect).label("phase")
        candidate_rank = func.row_number().over(
            partition_by=phase,
            order_by=(Game.played_at.desc(), Game.id.desc(), child_gp.ply.asc()),
        ).label("phase_rank")
        conditions = [
            _member_of(Game.id, game_ids, dialect=self.dialect),
            child_gp.move_uci.is_not(None),
            or_(
                and_(Game.user_color == "white", child_gp.ply % 2 == 1),
                and_(Game.user_color == "black", child_gp.ply % 2 == 0),
            ),
            or_(
                ~self.is_resolved(parent_position.id),
                ~self.is_resolved(child_position.id),
                self.is_deep_outlier(parent_position.id),
                self.is_deep_outlier(child_position.id),
            ),
        ]
        if seen_pairs and _SEEN_PAIRS_IN_SQL:
            # A bounded batch of the earliest pairs seen, which are the ones
            # that recur. Only an optimisation: a pair left out of it is
            # skipped in Python, and the doubling window still ends the page.
            conditions.append(
                _pair_not_among(
                    parent_position.id,
                    child_position.id,
                    islice(seen_pairs, _SEEN_PAIRS_IN_SQL),
                    dialect=self.dialect,
                )
            )
        # Excluded in the walk, not after it: filtering a finished pool left a
        # small one empty whenever its newest pairs were the excluded ones.
        if self.scope.excluded_fens:
            excluded = self.scope.excluded_fens
            conditions.append(_not_member_of(parent_position.fen, excluded, dialect=self.dialect))
            conditions.append(_not_member_of(child_position.fen, excluded, dialect=self.dialect))
        candidates = (
            select(
                parent_position.id.label("parent_id"),
                parent_position.fen.label("parent_fen"),
                child_position.id.label("child_id"),
                child_position.fen.label("child_fen"),
                child_gp.ply.label("ply"),
                child_gp.think_seconds.label("think_seconds"),
                phase,
                candidate_rank,
            )
            .select_from(Game)
            .join(child_gp, child_gp.game_id == Game.id)
            .join(
                parent_gp,
                and_(
                    parent_gp.game_id == child_gp.game_id,
                    parent_gp.ply == child_gp.ply - 1,
                ),
            )
            .join(parent_position, parent_position.id == parent_gp.position_id)
            .join(child_position, child_position.id == child_gp.position_id)
            .where(*conditions)
            .subquery()
        )
        rows = await self.session.execute(
            select(
                candidates.c.parent_id,
                candidates.c.parent_fen,
                candidates.c.child_id,
                candidates.c.child_fen,
                candidates.c.ply,
                candidates.c.think_seconds,
                candidates.c.phase,
            )
            .where(candidates.c.phase_rank <= per_phase)
            .limit(remaining)
        )
        return rows.all()

    async def load_depths(
        self,
        pairs: list[_DecisionPairTarget],
    ) -> tuple[dict[int, int], set[int]]:
        """Each position's depth on record, and which positions are finished games.

        One read for both. They were two round trips for every page of the
        walk and every request, and a finished game is just a position with no
        depth: its row arrives here with a NULL one.
        """

        min_depth = self.scope.min_depth
        position_ids = sorted({
            position_id
            for pair in pairs
            for position_id in (pair.parent_position_id, pair.child_position_id)
        })
        # The deepest search on record per position, so a pair can be brought to a
        # depth both sides share instead of differencing two different searches.
        depth_by_position: dict[int, int] = {}
        # Finished games are exact rather than searched: no work, no depth.
        exact_position_ids: set[int] = set()
        if not position_ids:
            return depth_by_position, exact_position_ids
        rows = await self.session.execute(
            union_all(
                select(AnalysisResult.position_id, AnalysisResult.depth).where(
                    _member_of(AnalysisResult.position_id, position_ids, dialect=self.dialect),
                    AnalysisResult.engine == ENGINE_NAME,
                    AnalysisResult.engine_version == ENGINE_VERSION,
                    AnalysisResult.depth >= min_depth,
                    AnalysisResult.multipv_rank == 1,
                ),
                select(PositionOutcome.position_id, cast(null(), Integer)).where(
                    _member_of(PositionOutcome.position_id, position_ids, dialect=self.dialect)
                ),
            )
        )
        in_band: dict[int, int] = {}
        for position_id, depth in rows.all():
            position_id = int(position_id)
            if depth is None:
                exact_position_ids.add(position_id)
                continue
            depth = int(depth)
            depth_by_position[position_id] = max(depth_by_position.get(position_id, 0), depth)
            if depth - min_depth <= MAX_PAIR_DEPTH_GAP:
                in_band[position_id] = depth
        # Graded at the review depth, a position with a row in the band is
        # done there however deep its deepest row is.
        if self.scope.review_band:
            depth_by_position.update(in_band)
        return depth_by_position, exact_position_ids

    def pair_work(self, pair: _DecisionPairTarget, depth_by_position, exact_position_ids):
        return _pair_work(
            pair,
            depth_by_position=depth_by_position,
            exact_position_ids=exact_position_ids,
            min_depth=self.scope.min_depth,
            review_band=self.scope.review_band,
        )

    async def collect_pairs(
        self,
        *,
        target: int,
        era_filters: list,
        recent_pairs: list[_DecisionPairTarget],
        seen_pairs: dict[tuple[int, int], None],
    ) -> None:
        """Walk games newest-first inside one era, adding the work they need."""

        game_cursor: tuple[datetime, int] | None = None
        # Grows only if a page fails to fill the target. The pair query joins
        # every decision in the page and sorts the lot to keep the best ~96, so
        # its cost tracks the page size almost exactly: measured at 55.7ms for
        # 250 games, 12.7ms for 50, 7.6ms for 25. A fixed large page paid for
        # ten thousand candidate rows to use ninety-six. A fixed small one would
        # page repeatedly once most positions are analysed and each game yields
        # little work, so start small and double until the page earns its size.
        chunk = _GAME_CHUNK_START
        while True:
            page_query = select(Game.id, Game.played_at).where(*self.filters, *era_filters)
            if game_cursor is not None:
                cursor_time, cursor_id = game_cursor
                page_query = page_query.where(or_(
                    Game.played_at < cursor_time,
                    and_(Game.played_at == cursor_time, Game.id < cursor_id),
                ))
            game_page = (await self.session.execute(
                page_query.order_by(Game.played_at.desc(), Game.id.desc()).limit(chunk)
            )).all()
            if not game_page:
                break
            game_ids = [int(game_id) for game_id, _ in game_page]
            game_cursor = (game_page[-1].played_at, int(game_page[-1].id))
            # Each phase gets its own share of the page instead of the first N
            # rows in ply order, which is the opening and early middlegame of
            # the newest game or two. Measured before this: with 26,663 endgame
            # decisions still needing work, 17% of everything outstanding, a
            # 24-position batch surfaced one. A phase with nothing to offer
            # simply contributes nothing; the others keep their shares, and
            # `_phase_balanced_pair_fens` still does the final rotation over
            # whatever arrives.
            #
            # A page is read until it stops yielding, not once. Rows the walk
            # cannot use -- an already-comparable deep pair, or a decision
            # already taken from a newer game -- still occupy their phase's
            # share of a read, and they rank first: the player's main-line
            # openings recur in every game and are searched to 34 on both sides.
            # Read once, those took the opening's whole share of every page and
            # the work behind them was never looked at; measured on the live
            # library, a walk aiming for 200 pairs came back holding 11, all of
            # them positions the crawler had timed out on and excluded, so a
            # one-engine crawl got nothing at all for thirty hours. Each read
            # now leaves out every pair already seen, so it can only return
            # new rows, and the page is re-read only when a phase filled its
            # share -- a read that came back short has nothing left behind it.
            # A read costs about the same whatever it returns -- the query ranks
            # the whole page either way -- so each re-read of a page asks for
            # twice as much as the last rather than paying for many small ones.
            window = 1
            while True:
                remaining = max(0, target - len(recent_pairs))
                per_phase = max(1, -(-remaining // len(_PHASES))) * window
                read_limit = remaining * window
                page_rows = await self.read_page_pairs(
                    game_ids, per_phase, read_limit, seen_pairs=seen_pairs
                )
                page_pairs = [
                    _DecisionPairTarget(
                        parent_position_id=int(parent_id),
                        parent_fen=parent_fen,
                        child_position_id=int(child_id),
                        child_fen=child_fen,
                        ply=int(ply),
                        think_seconds=None if think_seconds is None else float(think_seconds),
                    )
                    for parent_id, parent_fen, child_id, child_fen, ply, think_seconds, _
                    in page_rows
                ]
                # The SQL counts a side searched past the review band as work
                # even when its partner was searched just as deep; one small
                # depth lookup per read drops those here, because every exact
                # SQL form of the check measured slower (see CLAUDE.md).
                page_depths, page_exact = await self.load_depths(page_pairs)
                for pair in page_pairs:
                    key = (pair.parent_position_id, pair.child_position_id)
                    if key in seen_pairs:
                        continue
                    seen_pairs[key] = None
                    if len(recent_pairs) < target and self.pair_work(pair, page_depths, page_exact):
                        recent_pairs.append(pair)
                if len(recent_pairs) >= target:
                    break
                per_phase_counts: dict[str, int] = {}
                for *_, row_phase in page_rows:
                    per_phase_counts[row_phase] = per_phase_counts.get(row_phase, 0) + 1
                filled_a_share = len(page_rows) >= read_limit or any(
                    count >= per_phase for count in per_phase_counts.values()
                )
                if not filled_a_share:
                    break
                window *= 2
            if len(recent_pairs) >= target or len(game_page) < chunk:
                break
            # The page was full and still short of the target, so the next one
            # has to cover more ground.
            chunk = min(chunk * 2, _GAME_CHUNK_MAX)

    async def build_pool(self) -> list[_DecisionPairTarget]:
        """Walk the library for decision pairs with work, era by era.

        Improvement analysis needs both sides of the user's decision before it
        can measure evaluation loss, so pairs are selected as units.

        The walk rotates across eras of the player's history, not only the
        newest games. A pure newest-first walk buries the rest of the library:
        measured after a crawl session, the current month held 379 distinct
        covered decisions against 19-42 for every earlier month. That skew is
        not just unfair to old games, it makes the library untestable, because
        scoring the drill ranking (and every "is this pattern getting better?"
        trend) compares an older window against a recent one, and the older
        window stays empty forever. The newest era is still walked first and
        keeps whatever the others cannot fill, so recent play is not starved.

        Sorting every decision in a large corpus made a 24-position request
        scan all 159k of one player's decisions, so each era walks already
        ordered game ids in bounded chunks and stops as soon as it has enough.
        """

        pair_target = self.scope.pair_target
        recent_pairs: list[_DecisionPairTarget] = []
        # Every (parent, child) the walk has read, kept or not. A decision counts
        # once however many games it occurred in -- openings repeat, and counting
        # instances filled the target with copies of the newest few pairs -- and a
        # pair already judged is left out of every later read, which is what lets a
        # page be re-read without handing back the rows it has already given.
        # A dict for its order: the earliest pairs seen are the ones that recur.
        seen_pairs: dict[tuple[int, int], None] = {}
        bounds = (await self.session.execute(
            select(func.min(Game.played_at), func.max(Game.played_at)).where(*self.filters)
        )).one()
        eras: list[list] = [[]]
        if bounds[0] is not None and bounds[1] is not None and bounds[1] > bounds[0]:
            span = (bounds[1] - bounds[0]) / _HISTORY_ERAS
            edges = [bounds[0] + span * index for index in range(_HISTORY_ERAS + 1)]
            eras = [
                [Game.played_at >= edges[index], Game.played_at <= edges[index + 1]]
                if index == _HISTORY_ERAS - 1
                else [Game.played_at >= edges[index], Game.played_at < edges[index + 1]]
                for index in reversed(range(_HISTORY_ERAS))
            ]
        era_share = max(1, pair_target // len(eras))
        for era_index, era_filters in enumerate(eras):
            # The last era may take whatever the earlier ones left unspent.
            target = pair_target if era_index == len(eras) - 1 else min(
                pair_target, len(recent_pairs) + era_share
            )
            if len(recent_pairs) >= target:
                continue
            await self.collect_pairs(
                target=target,
                era_filters=era_filters,
                recent_pairs=recent_pairs,
                seen_pairs=seen_pairs,
            )
            if len(recent_pairs) >= pair_target:
                break
        return recent_pairs


async def _store_pool(
    pool_key: str, rebuilt_key: str, pairs: list[_DecisionPairTarget], *, pair_target: int,
) -> None:
    cache = get_shared_cache()
    await cache.set_json(
        pool_key,
        {"built_at": time.time(), "pairs": [asdict(pair) for pair in pairs]},
        ttl_seconds=_POOL_KEEP_SECONDS,
    )
    if len(pairs) < pair_target:
        await cache.set_json(rebuilt_key, True, ttl_seconds=_POOL_SHORT_REST_SECONDS)


def _pool_flight(
    session: AsyncSession,
    scope: _QueueScope,
    pool_key: str,
    rebuilt_key: str,
    *,
    observed_built_at: float | None = None,
) -> asyncio.Task[list[_DecisionPairTarget]] | None:
    """The one walk of this pool in progress, started here if there is none.

    A walk reads the whole library: 2.5-3s on a quiet machine, 4.5-11.3s under
    load, once 44.5s. Run inside the request, every request that found the
    pool missing or short ran its own, side by side, and a crawler that gave
    up waiting threw its walk away and began another on its next try. The walk
    is now a task on a session of its own, keyed on the pool it fills: a
    second request for the same scope joins it, and a request that goes away
    leaves it running for the next one to find finished.

    Returns None when the request's session has no engine to open another
    session on, in which case the caller walks on its own session.
    """

    engine = _async_engine_for(session)
    if engine is None:
        return None
    running = _pool_flights.get(pool_key)
    if running is not None and not running.done():
        return running

    async def walk() -> list[_DecisionPairTarget]:
        # Another flight may have finished since the caller read the cache.
        current = await get_shared_cache().get_json(pool_key)
        if current is not None and current["built_at"] != observed_built_at:
            return [_DecisionPairTarget(**item) for item in current["pairs"]]
        async with AsyncSession(bind=engine, expire_on_commit=False) as own:
            built = await _QueueReader(own, scope).build_pool()
        await _store_pool(pool_key, rebuilt_key, built, pair_target=scope.pair_target)
        return built

    def landed(task: asyncio.Task[list[_DecisionPairTarget]]) -> None:
        if _pool_flights.get(pool_key) is task:
            del _pool_flights[pool_key]
        if not task.cancelled() and (error := task.exception()) is not None:
            logger.warning("Analysis queue pool walk for %s failed", scope.username, exc_info=error)

    task = _pool_flights[pool_key] = asyncio.create_task(walk())
    task.add_done_callback(landed)
    return task


@router.get("/unanalyzed-fens")
@router.post("/unanalyzed-fens")
async def unanalyzed_fens(
    username: str = Query(...),
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    min_depth: Annotated[int, Query(ge=1, le=128)] = 18,
    limit: Annotated[int, Query(ge=1, le=500)] = 500,
    min_user_rating: Annotated[int | None, Query(ge=100, le=4000)] = None,
    # Bring pairs to the review depth rather than to their deepest side; see
    # `_pair_work`. Only for a client that stores a shallower search beside a
    # deeper one, which the browser's depth-max cache does not.
    shallow_pairs: bool = False,
    session: AsyncSession = Depends(get_db),
    exclusions: AnalysisQueueExclusions | None = None,
) -> dict[str, object]:
    if min_user_rating is None:
        min_user_rating = await player_rating_floor(session, username)
    excluded_fens = list(dict.fromkeys(
        normalize_fen(fen) for fen in exclusions.exclude_fens
    )) if exclusions else []
    scope = _QueueScope(
        username=username,
        color=color,
        time_class=time_class,
        min_depth=min_depth,
        min_user_rating=min_user_rating,
        review_band=shallow_pairs,
        excluded_fens=tuple(excluded_fens),
        pair_target=max(_MIN_RECENT_DECISIONS, limit * _RECENT_DECISION_OVERFETCH),
    )
    reader = _QueueReader(session, scope)
    filters = reader.filters
    dialect = reader.dialect
    cache = get_shared_cache()

    candidate_count, analyzed_count = await reader.coverage_counts()

    # The walk reads the whole library to find sparse middlegame work, and the
    # crawler asks every batch, yet between batches the work barely changes:
    # only the positions just searched drop off. So the pool is built once and
    # reused; each request re-checks only its own positions' depths (one small
    # query). Imports clear it (`invalidate_improvement_caches`).
    excluded = set(excluded_fens)

    def usable(pairs: list[_DecisionPairTarget]) -> list[_DecisionPairTarget]:
        return [
            pair for pair in pairs
            if pair.parent_fen not in excluded and pair.child_fen not in excluded
        ]

    pool_base = scope.pool_base()
    pool_key = await cache.versioned_key(pool_base)
    # Under the pool's prefix, so an import drops it with the pool.
    rebuilt_key = await cache.versioned_key(f"{pool_base}:rebuilt")
    cached_pool = await cache.get_json(pool_key)
    pool: list[_DecisionPairTarget] | None = None
    # Serve an old or depleted pool while rebuilding if it still has work.
    observed_built_at: float | None = None
    refresh_built_at: float | None = None
    if cached_pool is not None:
        pool = usable([_DecisionPairTarget(**item) for item in cached_pool["pairs"]])
        depth_by_position, exact_position_ids = await reader.load_depths(pool)
        with_work = sum(
            1 for pair in pool if reader.pair_work(pair, depth_by_position, exact_position_ids)
        )
        observed_built_at = float(cached_pool["built_at"])
        aged = time.time() - observed_built_at > _POOL_TTL_SECONDS
        # A walk that returned short is repeated at most once a rest. With the library
        # nearly all analysed every pool is short, and walking on each request
        # read the whole library for nothing new: 145 of 166 crawler requests
        # in a day took 3-10s (three ~90s), against ~63ms reused.
        short = with_work < limit * _POOL_REFILL_FACTOR
        filled_target = len(cached_pool["pairs"]) >= scope.pair_target
        if aged or (short and (filled_target or await cache.get_json(rebuilt_key) is None)):
            if with_work and _async_engine_for(session) is not None:
                refresh_built_at = observed_built_at
            else:
                pool = None
    if pool is None:
        flight = _pool_flight(session, scope, pool_key, rebuilt_key, observed_built_at=observed_built_at)
        if flight is None:
            built = await reader.build_pool()
            await _store_pool(pool_key, rebuilt_key, built, pair_target=scope.pair_target)
        else:
            # This request has only read so far. Its transaction is closed
            # rather than left open and idle for as long as the walk takes.
            await session.commit()
            # Shielded: a client that stops waiting must not take the walk,
            # and everyone else waiting on it, down with it.
            built = await asyncio.shield(flight)
        pool = usable(built)
        depth_by_position, exact_position_ids = await reader.load_depths(pool)
    # The newest sitting goes first. The Habits coach reads the newest game
    # with most of its moves judged, and an era rotation hands a fresh game
    # the same share as any old one: measured the day it was built, the three
    # games just played had 180 positions unsearched and none of them in the
    # batch the crawler was served. A sitting is a few games, so this costs one
    # small read and leaves the rotation everything else.
    fresh_fens: list[str] = []
    fresh_targets: dict[str, int] = {}
    newest = (await session.execute(select(func.max(Game.played_at)).where(*filters))).scalar()
    if newest is not None and newest.tzinfo is None:
        newest = newest.replace(tzinfo=UTC)
    # Only a sitting still going on, or just finished: an old library has no
    # "newest game" worth jumping the rotation for.
    if newest is not None and datetime.now(UTC) - newest <= _FRESH_RECENT:
        fresh_ids = [
            int(game_id)
            for game_id in (await session.execute(
                select(Game.id)
                .where(*filters, Game.played_at >= newest - _FRESH_WINDOW)
                .order_by(Game.played_at.desc(), Game.id.desc())
                .limit(_FRESH_GAMES)
            )).scalars()
        ]
        if fresh_ids:
            # Nothing counts as seen here: the pool's walk has read the newest
            # games' pairs too, and this read must not skip them for that.
            fresh_rows = await reader.read_page_pairs(
                fresh_ids, limit, limit * len(_PHASES), seen_pairs={}
            )
            fresh_pairs = [
                _DecisionPairTarget(
                    parent_position_id=int(parent_id), parent_fen=parent_fen,
                    child_position_id=int(child_id), child_fen=child_fen, ply=int(ply),
                )
                for parent_id, parent_fen, child_id, child_fen, ply, _think, _phase in fresh_rows
            ]
            fresh_depths, fresh_exact = await reader.load_depths(fresh_pairs)
            for pair in sorted(fresh_pairs, key=lambda item: item.ply):
                work = reader.pair_work(pair, fresh_depths, fresh_exact)
                if not work or len(fresh_fens) + len(work) > limit:
                    continue
                for fen, depth in work:
                    if fen not in fresh_targets:
                        fresh_fens.append(fen)
                        fresh_targets[fen] = depth

    # Rotate across phases and preserve recency within each. This keeps an
    # analysis session from spending its first several batches deepening an
    # already dominant opening sample while middlegames and endgames remain
    # invisible.
    recent_pairs = [
        pair for pair in pool
        if pair.parent_fen not in fresh_targets and pair.child_fen not in fresh_targets
    ]
    fens, selected_pair_counts, depth_targets = _phase_balanced_pair_fens(
        recent_pairs,
        depth_by_position=depth_by_position,
        exact_position_ids=exact_position_ids,
        min_depth=min_depth,
        limit=limit - len(fresh_fens),
        review_band=scope.review_band,
    )
    fens = fresh_fens + fens
    depth_targets = {**depth_targets, **fresh_targets}
    if fresh_fens:
        selected_pair_counts = {**selected_pair_counts, "fresh": len(fresh_fens)}

    # Malformed/partial historical rows cannot form a pair. Preserve the old
    # recent-position walk as a bounded fallback before global recurrence.
    already_selected = set(fens)
    already_analyzed = reader.is_resolved(Position.id)
    not_excluded = (
        [_not_member_of(Position.fen, excluded_fens, dialect=dialect)] if excluded_fens else []
    )

    async def fill_from(query, order_by) -> None:
        """Read a fallback in growing windows until the batch is full or it runs out.

        One fixed window was not enough: the newest unanalysed positions of
        this library are Chess960 games, which the evaluations endpoint cannot
        store, so a crawler asking for 5 read 20 of them and was told the queue
        was empty for a whole night while real work waited behind them.
        """
        window = max(limit, limit * 4)
        offset = 0
        for _ in range(_FALLBACK_READS):
            rows = (
                await session.execute(query.order_by(*order_by).offset(offset).limit(window))
            ).scalars().all()
            for fen in rows:
                if fen in already_selected or not _is_storable_fen(fen):
                    continue
                fens.append(fen)
                already_selected.add(fen)
                if len(fens) >= limit:
                    return
            if len(rows) < window:
                return
            offset += window
            window *= 2

    if len(fens) < limit:
        await fill_from(
            select(Position.fen)
            .select_from(Game)
            .join(GamePosition, GamePosition.game_id == Game.id)
            .join(Position, Position.id == GamePosition.position_id)
            .where(*filters, ~already_analyzed, *not_excluded),
            (Game.played_at.desc(), Game.id.desc(), GamePosition.ply.asc()),
        )

    if len(fens) < limit:
        # Once the recent frontier is covered, recurrent positions keep older
        # history moving forward efficiently via positions.total_games.
        played_by_user = (
            select(GamePosition.id)
            .join(Game, Game.id == GamePosition.game_id)
            .where(GamePosition.position_id == Position.id, *filters)
            .exists()
        )
        await fill_from(
            select(Position.fen).where(
                Position.total_games >= 1,
                played_by_user,
                ~already_analyzed,
                *not_excluded,
            ),
            (Position.total_games.desc(), Position.id.asc()),
        )
    # Started last, once this request has read everything it needs, so the
    # walk does not compete with the answer it is following.
    if refresh_built_at is not None:
        _pool_flight(session, scope, pool_key, rebuilt_key, observed_built_at=refresh_built_at)
    return {
        "fens": fens,
        # Per-FEN search depth. A decision is graded by differencing its two
        # positions, so each is searched to the depth its partner already
        # carries rather than to one global default.
        "fen_depths": {fen: depth_targets.get(fen, min_depth) for fen in fens},
        "candidate_count": candidate_count,
        "analyzed_count": analyzed_count,
        "missing_count": max(0, candidate_count - analyzed_count),
        "limit": limit,
        "min_depth": min_depth,
        # What a crawl should search to. A client that picks its own number
        # fills the library at a depth this endpoint's coverage query does not
        # count, and the work is silently redone.
        "review_depth": GAME_REVIEW_DEPTH,
        "min_user_rating": min_user_rating,
        "selection_strategy": "phase_balanced_recent_decision_pairs_then_recurrence",
        "selected_decision_pairs_by_phase": selected_pair_counts,
    }


def _has_a_second_line(fen: str) -> bool:
    """Whether a MultiPV search of this position can return more than one line.

    A position with one legal move never gets a second line however it is
    searched, so it could never leave the list and would be offered forever.
    """

    try:
        board = chess.Board(fen if len(fen.split()) == 6 else f"{fen} 0 1")
    except ValueError:
        return False
    return board.legal_moves.count() >= 2


@router.get("/trainer-multipv-fens")
async def trainer_multipv_fens(
    username: str = Query(..., min_length=1, max_length=64),
    limit: int = Query(default=6, ge=1, le=25),
    session: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    """Trainer positions still waiting for their second and third engine lines.

    Blunder Check and Punish it ask for one move and are judged against the
    engine's first line, because the library crawl searches one line a
    position. A position with a second move nearly as good needs its other
    lines stored before that move can be accepted. This lists the newest
    trainer positions with no line past the first at the review depth, for
    the crawler to search at MultiPV 3 once the main queue is caught up; a
    position leaves the list when the upload stores a second line for it.
    """

    floor = await player_rating_floor(session, username)
    blunders = await threats.cached_threat_pool(session, username, min_user_rating=floor)
    gifts = await threats.cached_punish_pool(session, username, min_user_rating=floor)
    # Both pools arrive newest first; merged, the newest games of either lead.
    candidates: list[tuple[int, str]] = []
    listed: set[int] = set()
    for item in sorted(blunders + gifts, key=lambda item: item["played_at"], reverse=True):
        position_id = int(item["position_id"])
        if position_id in listed:
            continue
        listed.add(position_id)
        candidates.append((position_id, item["fen"]))

    dialect = _dialect_name(session)
    fens: list[str] = []
    for start in range(0, len(candidates), _TRAINER_BATCH):
        batch = candidates[start:start + _TRAINER_BATCH]
        enriched = set(
            (
                await session.execute(
                    select(AnalysisResult.position_id)
                    .where(
                        _member_of(
                            AnalysisResult.position_id,
                            [position_id for position_id, _ in batch],
                            dialect=dialect,
                        ),
                        AnalysisResult.engine == ENGINE_NAME,
                        AnalysisResult.engine_version == ENGINE_VERSION,
                        AnalysisResult.multipv_rank >= 2,
                        AnalysisResult.depth >= GAME_REVIEW_DEPTH - MAX_PAIR_DEPTH_GAP,
                        AnalysisResult.depth <= GAME_REVIEW_DEPTH + MAX_PAIR_DEPTH_GAP,
                    )
                    .distinct()
                )
            ).scalars()
        )
        for position_id, fen in batch:
            if position_id in enriched or not _is_storable_fen(fen) or not _has_a_second_line(fen):
                continue
            fens.append(fen)
            if len(fens) >= limit:
                return {"fens": fens, "review_depth": GAME_REVIEW_DEPTH}
    return {"fens": fens, "review_depth": GAME_REVIEW_DEPTH}


@router.get("/{game_id}", response_model=GameOut)
async def get_game(game_id: int, session: AsyncSession = Depends(get_db)) -> GameOut:
    game = await session.get(Game, game_id)
    if game is None:
        raise HTTPException(status_code=404, detail="Game not found")
    return GameOut.model_validate(game)
