from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Annotated

import chess
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.database import get_db
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
from app.services.cache import get_shared_cache
from app.utils.fen import normalize_fen
from app.services.game_scope import (
    DEFAULT_MIN_USER_RATING,
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

_COVERAGE_TTL_SECONDS = 300.0  # a progress label; imports clear it
_RECENT_DECISION_OVERFETCH = 16
_MIN_RECENT_DECISIONS = 200
# How many games one page of the walk covers. Adaptive: see collect_pairs.
_GAME_CHUNK_START = 32
_GAME_CHUNK_MAX = 512
# Slices of the player's history the queue rotates through, so coverage does
# not pile into the newest games and leave every older window untestable.
_HISTORY_ERAS = 4
# How long the analysis queue's pool of decision pairs is reused, and how many
# pairs with work (as a multiple of the request) it must hold to be reused.
_POOL_TTL_SECONDS = 600.0
_POOL_REFILL_FACTOR = 4


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
    already chosen — and the pool is where the bias lives. Ordering a page by
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


def _is_storable_fen(fen: str) -> bool:
    """Whether the evaluations endpoint could store a search of this position.

    Mirrors the FEN half of AnalysisEvaluationItemIn.validate_chess_analysis: a
    four- or six-field FEN that parses but fails python-chess validity is
    rejected with 422, so offering it only burns an engine search plus two
    uploads every batch forever — the queue re-offers a position until it is
    analysed, and one of these can never become analysed. Seen in the wild:
    stale castling rights (`kq` on a board whose king has left e8), which the
    engine searches happily and the validator refuses.
    """
    parts = fen.split()
    if len(fen) > 120 or len(parts) not in (4, 6):
        return False
    try:
        board = chess.Board(fen if len(parts) == 6 else f"{fen} 0 1")
    except ValueError:
        return False
    return board.is_valid()


def _pair_work(
    pair: _DecisionPairTarget,
    *,
    depth_by_position: dict[int, int],
    exact_position_ids: set[int],
    min_depth: int,
) -> list[tuple[str, int]]:
    """The searches this decision still needs, as (fen, depth) targets.

    An evaluation loss is the difference between two searches, so a decision can
    only be graded once both of its positions have been searched to a depth they
    share. The pair is brought to the deepest evidence either side already
    carries: a parent someone studied on the board at depth 30 is not re-run
    shallower — a shallower result would be discarded by the browser's own
    depth-max cache and the pair would stay ungradeable forever — the child is
    searched to depth 30 instead, which also makes the measurement better.
    """

    sides = (
        (pair.parent_position_id, pair.parent_fen),
        (pair.child_position_id, pair.child_fen),
    )
    # A finished game is exact rather than searched: it needs no work and
    # constrains no depth. A position the evaluations endpoint cannot store
    # needs no search either — offering it burns an engine job every batch
    # while the pair stays ungradeable forever (see _is_storable_fen). The
    # storable side of a half-bad pair is still offered: its search stands on
    # its own in every other decision that reaches the position.
    searchable = [
        (pid, fen) for pid, fen in sides
        if pid not in exact_position_ids and _is_storable_fen(fen)
    ]
    known = [depth_by_position[pid] for pid, _ in searchable if pid in depth_by_position]
    target = max([min_depth, *known])
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
) -> tuple[list[str], dict[str, int], dict[str, int]]:
    """Select complete decision pairs while rotating through game phases."""

    exact_position_ids = exact_position_ids or set()

    def work_for(pair: _DecisionPairTarget) -> list[tuple[str, int]]:
        return _pair_work(
            pair,
            depth_by_position=depth_by_position,
            exact_position_ids=exact_position_ids,
            min_depth=min_depth,
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
    # order by — but there is the clock, which costs no engine time and turns
    # out to say a great deal. Measured over 210 decisions from this library,
    # searched at depth 22: moves played in under a second were wrong 8% of the
    # time, the broad middle 23-32%, and moves the player thought about for 15
    # seconds or more were wrong 53% of the time and lost 200cp or more 41% of
    # the time. That is the opposite of the usual assumption that rushed moves
    # are the blunders: a fast move is usually a forced or obvious one, while a
    # long think marks a position the player found genuinely hard — which is
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
    # while — how many of the player's decisions one search unlocks — which
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


def apply_position_join(stmt, fen: str | None):
    if not fen:
        return stmt
    return (
        stmt.join(GamePosition, GamePosition.game_id == Game.id)
        .join(Position, Position.id == GamePosition.position_id)
        .where(Position.fen == fen)
    )


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

    total_stmt = apply_position_join(
        select(func.count(func.distinct(Game.id))).select_from(Game).where(*filters),
        fen,
    )
    total = await session.scalar(total_stmt)
    id_stmt = apply_position_join(
        select(Game.id, Game.played_at)
        .where(*filters)
        .group_by(Game.id, Game.played_at)
        .order_by(Game.played_at.desc(), Game.id.desc())
        .offset((page - 1) * per_page)
        .limit(per_page),
        fen,
    )
    result = await session.execute(id_stmt)
    game_ids = [row[0] for row in result.all()]
    if not game_ids:
        return GameListOut(games=[], total=total or 0, page=page, per_page=per_page)

    games_result = await session.execute(select(Game).where(Game.id.in_(game_ids)))
    games_by_id = {game.id: game for game in games_result.scalars().all()}
    analyzed_result = await session.execute(
        select(GamePosition.game_id)
        .join(AnalysisResult, AnalysisResult.position_id == GamePosition.position_id)
        .where(
            GamePosition.game_id.in_(game_ids),
            AnalysisResult.engine == ENGINE_NAME,
            AnalysisResult.engine_version == ENGINE_VERSION,
            AnalysisResult.depth >= 20,
            AnalysisResult.multipv_rank == 1,
        )
        .distinct()
    )
    analyzed_game_ids = set(analyzed_result.scalars().all())
    games = [
        GameOut.model_validate(games_by_id[game_id]).model_copy(update={"has_analysis": game_id in analyzed_game_ids})
        for game_id in game_ids
        if game_id in games_by_id
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

    totals = await session.execute(
        select(
            func.count(Game.id),
            func.sum(case((Game.user_result == "win", 1), else_=0)),
            func.sum(case((Game.user_color == "white", 1), else_=0)),
        ).where(*filters)
    )
    total_games, wins, _ = totals.one()
    total_games = total_games or 0
    wins = wins or 0
    if not total_games:
        return GameStatsOut(
            by_color={"white": ColorStats(), "black": ColorStats()},
            by_time_class={},
            by_opening=[],
        )

    color_rows = await session.execute(
        select(
            Game.user_color,
            func.sum(case((Game.user_result == "win", 1), else_=0)),
            func.sum(case((Game.user_result == "loss", 1), else_=0)),
            func.sum(case((Game.user_result == "draw", 1), else_=0)),
        )
        .where(*filters)
        .group_by(Game.user_color)
    )
    color_stats = {"white": ColorStats(), "black": ColorStats()}
    for user_color, row_wins, losses, draws in color_rows.all():
        if user_color in color_stats:
            color_stats[user_color] = ColorStats(
                wins=row_wins or 0,
                losses=losses or 0,
                draws=draws or 0,
            )

    by_time_class: dict[str, TimeClassStats] = {}
    time_rows = await session.execute(
        select(
            Game.time_class,
            func.count(Game.id),
            func.sum(case((Game.user_result == "win", 1), else_=0)),
            func.sum(case((Game.user_result == "loss", 1), else_=0)),
            func.sum(case((Game.user_result == "draw", 1), else_=0)),
        )
        .where(*filters)
        .group_by(Game.time_class)
    )
    for time_class_name, class_total, class_wins, class_losses, class_draws in time_rows.all():
        class_wins = class_wins or 0
        class_losses = class_losses or 0
        class_draws = class_draws or 0
        by_time_class[time_class_name] = TimeClassStats(
            games=class_total,
            wins=class_wins,
            losses=class_losses,
            draws=class_draws,
            win_rate=round(class_wins / class_total, 4) if class_total else 0.0,
        )

    opening_rows = await session.execute(
        select(func.coalesce(Game.opening_name, "Unknown"), func.count(Game.id))
        .where(*filters)
        .group_by(Game.opening_name)
        .order_by(func.count(Game.id).desc())
        .limit(10)
    )

    return GameStatsOut(
        total_games=total_games,
        win_rate=round(wins / total_games, 4),
        by_color=color_stats,
        by_time_class=by_time_class,
        by_opening=[
            OpeningStat(opening_name=name, games=count)
            for name, count in opening_rows.all()
        ],
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
    page: int = 1,
    per_page: int = 20,
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
        # above an opening played hundreds of times — and since the list is
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


@router.get("/unanalyzed-fens")
@router.post("/unanalyzed-fens")
async def unanalyzed_fens(
    username: str = Query(...),
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    min_depth: Annotated[int, Query(ge=1, le=128)] = 18,
    limit: Annotated[int, Query(ge=1, le=500)] = 500,
    min_user_rating: Annotated[int, Query(ge=100, le=4000)] = DEFAULT_MIN_USER_RATING,
    session: AsyncSession = Depends(get_db),
    exclusions: AnalysisQueueExclusions | None = None,
) -> dict[str, object]:
    excluded_fens = list(dict.fromkeys(
        normalize_fen(fen) for fen in exclusions.exclude_fens
    )) if exclusions else []
    filters = [
        Game.username == username,
        user_rating_condition(Game, min_user_rating),
    ]
    if color != "both":
        filters.append(Game.user_color == color)
    time_filter = time_class_condition(Game.time_class, time_class)
    if time_filter is not None:
        filters.append(time_filter)

    played_by_user = (
        select(GamePosition.id)
        .join(Game, Game.id == GamePosition.game_id)
        .where(GamePosition.position_id == Position.id, *filters)
        .exists()
    )
    def is_resolved(position_id):
        return or_(
            select(AnalysisResult.id).where(
                AnalysisResult.position_id == position_id,
                AnalysisResult.engine == ENGINE_NAME,
                AnalysisResult.engine_version == ENGINE_VERSION,
                AnalysisResult.depth >= min_depth,
                AnalysisResult.multipv_rank == 1,
            ).exists(),
            select(PositionOutcome.position_id).where(PositionOutcome.position_id == position_id).exists(),
        )

    def is_deep_outlier(position_id):
        # A position searched deeper than the review band — someone studied it
        # on the board. Its partner cannot be differenced against it at the
        # review depth, so the pair is work even though both sides are
        # "analyzed". Crawled positions never hit this, so the extra pairs this
        # admits are bounded by how much the player has studied by hand.
        return select(AnalysisResult.id).where(
            AnalysisResult.position_id == position_id,
            AnalysisResult.engine == ENGINE_NAME,
            AnalysisResult.engine_version == ENGINE_VERSION,
            AnalysisResult.depth > min_depth + MAX_PAIR_DEPTH_GAP,
            AnalysisResult.multipv_rank == 1,
        ).exists()

    already_analyzed = is_resolved(Position.id)
    resolved_positions = (
        select(AnalysisResult.position_id)
        .where(
            AnalysisResult.engine == ENGINE_NAME,
            AnalysisResult.engine_version == ENGINE_VERSION,
            AnalysisResult.depth >= min_depth,
            AnalysisResult.multipv_rank == 1,
        )
        .union(select(PositionOutcome.position_id))
    )

    # Coverage counts scan every game_position of the user (~seconds at millions
    # of rows) and only exist for the progress label, so cache them briefly —
    # the browser autopilot polls this endpoint every 30s.
    cache = get_shared_cache()
    cache_key = (
        f"coverage:v3:{username}:{color}:{time_class}:{min_depth}:{min_user_rating}"
    )
    cache_key = await cache.versioned_key(cache_key)
    cached_counts = await cache.get_json(cache_key)
    if cached_counts is not None:
        candidate_count, analyzed_count = int(cached_counts[0]), int(cached_counts[1])
    else:
        analyzed_positions = resolved_positions.cte("analyzed_positions")
        candidate_ids = (
            select(GamePosition.position_id)
            .join(Game, Game.id == GamePosition.game_id)
            .where(*filters)
            .distinct()
            .subquery()
        )
        count_row = await session.execute(
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

    # Improvement analysis needs both sides of the user's decision before it can
    # measure evaluation loss. Select those pairs as units, rotate across phases,
    # and preserve recency within each phase. This prevents an analysis session
    # from spending its first several batches deepening an already dominant
    # opening sample while middlegames and endgames remain invisible.
    child_gp = aliased(GamePosition)
    parent_gp = aliased(GamePosition)
    child_position = aliased(Position)
    parent_position = aliased(Position)
    parent_already_analyzed = is_resolved(parent_position.id)
    child_already_analyzed = is_resolved(child_position.id)
    recent_pair_target = max(
        _MIN_RECENT_DECISIONS,
        limit * _RECENT_DECISION_OVERFETCH,
    )
    recent_pairs: list[_DecisionPairTarget] = []
    # Sorting every decision in a large corpus made a 24-position request scan
    # all 159k Saint_Uwe decisions. Walk already ordered game IDs in bounded
    # chunks and stop as soon as there is enough phase-balanced work instead.
    dialect = session.bind.dialect.name if session.bind is not None else "postgresql"

    async def collect_pairs(*, target: int, era_filters: list) -> None:
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
            page_query = select(Game.id, Game.played_at).where(*filters, *era_filters)
            if game_cursor is not None:
                cursor_time, cursor_id = game_cursor
                page_query = page_query.where(or_(
                    Game.played_at < cursor_time,
                    and_(Game.played_at == cursor_time, Game.id < cursor_id),
                ))
            game_page = (await session.execute(
                page_query.order_by(Game.played_at.desc(), Game.id.desc()).limit(chunk)
            )).all()
            if not game_page:
                break
            game_ids = [int(game_id) for game_id, _ in game_page]
            game_cursor = (game_page[-1].played_at, int(game_page[-1].id))
            # Give each phase its own share of the page instead of taking the
            # first N rows in ply order, which is the opening and early
            # middlegame of the newest game or two. Measured before this: with
            # 26,663 endgame decisions still needing work — 17% of everything
            # outstanding — a 24-position batch surfaced one. A phase with
            # nothing to offer simply contributes nothing; the others keep their
            # shares, and `_phase_balanced_pair_fens` still does the final
            # rotation over whatever arrives.
            phase = _board_phase(parent_position.fen, child_gp.ply, dialect=dialect).label("phase")
            remaining = max(0, target - len(recent_pairs))
            per_phase = max(1, -(-remaining // len(_PHASES)))
            candidate_rank = func.row_number().over(
                partition_by=phase,
                order_by=(Game.played_at.desc(), Game.id.desc(), child_gp.ply.asc()),
            ).label("phase_rank")
            candidates = (
                select(
                    parent_position.id.label("parent_id"),
                    parent_position.fen.label("parent_fen"),
                    child_position.id.label("child_id"),
                    child_position.fen.label("child_fen"),
                    child_gp.ply.label("ply"),
                    child_gp.think_seconds.label("think_seconds"),
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
                .where(
                    Game.id.in_(game_ids),
                    child_gp.move_uci.is_not(None),
                    or_(
                        and_(Game.user_color == "white", child_gp.ply % 2 == 1),
                        and_(Game.user_color == "black", child_gp.ply % 2 == 0),
                    ),
                    or_(
                        ~parent_already_analyzed,
                        ~child_already_analyzed,
                        is_deep_outlier(parent_position.id),
                        is_deep_outlier(child_position.id),
                    ),
                )
                .subquery()
            )
            recent_pair_rows = await session.execute(
                select(
                    candidates.c.parent_id,
                    candidates.c.parent_fen,
                    candidates.c.child_id,
                    candidates.c.child_fen,
                    candidates.c.ply,
                    candidates.c.think_seconds,
                )
                .where(candidates.c.phase_rank <= per_phase)
                .limit(remaining)
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
                for parent_id, parent_fen, child_id, child_fen, ply, think_seconds
                in recent_pair_rows.all()
            ]
            # The SQL counts a side searched past the review band as work even
            # when its partner was searched just as deep, and those pairs — the
            # player's much-studied opening positions — made up 184 of a
            # 199-pair walk that held 15 real jobs. Every exact SQL form of the
            # check measured slower (see CLAUDE.md); one small depth lookup per
            # page drops them here, so the walk's target counts real work.
            page_depths, page_exact = await load_depths(page_pairs)
            recent_pairs.extend(
                pair for pair in page_pairs
                if _pair_work(
                    pair, depth_by_position=page_depths,
                    exact_position_ids=page_exact, min_depth=min_depth,
                )
            )
            if len(recent_pairs) >= target or len(game_page) < chunk:
                break
            # The page was full and still short of the target, so the next one
            # has to cover more ground.
            chunk = min(chunk * 2, _GAME_CHUNK_MAX)

    # Rotate across eras of the player's history, not only the newest games.
    # A pure newest-first walk buries the rest of the library: measured after a
    # crawl session, the current month held 379 distinct covered decisions
    # against 19-42 for every earlier month. That skew is not just unfair to old
    # games — it makes the library untestable, because scoring the drill ranking
    # (and every "is this pattern getting better?" trend) compares an older
    # window against a recent one, and the older window stays empty forever.
    # The newest era is still walked first and keeps whatever the others cannot
    # fill, so recent play is not starved either.
    async def build_pool() -> list[_DecisionPairTarget]:
        recent_pairs.clear()
        bounds = (await session.execute(
            select(func.min(Game.played_at), func.max(Game.played_at)).where(*filters)
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
        era_share = max(1, recent_pair_target // len(eras))
        for era_index, era_filters in enumerate(eras):
            # The last era may take whatever the earlier ones left unspent.
            target = recent_pair_target if era_index == len(eras) - 1 else min(
                recent_pair_target, len(recent_pairs) + era_share
            )
            if len(recent_pairs) >= target:
                continue
            await collect_pairs(target=target, era_filters=era_filters)
            if len(recent_pairs) >= recent_pair_target:
                break
        return list(recent_pairs)

    async def load_depths(
        pairs: list[_DecisionPairTarget],
    ) -> tuple[dict[int, int], set[int]]:
        recent_position_ids = {
            position_id
            for pair in pairs
            for position_id in (pair.parent_position_id, pair.child_position_id)
        }
        # The deepest search on record per position, so a pair can be brought to a
        # depth both sides share instead of differencing two different searches.
        depth_by_position: dict[int, int] = {}
        # Finished games are exact rather than searched: no work, no depth.
        exact_position_ids: set[int] = set()
        if recent_position_ids:
            depth_rows = await session.execute(
                select(AnalysisResult.position_id, AnalysisResult.depth).where(
                    AnalysisResult.position_id.in_(recent_position_ids),
                    AnalysisResult.engine == ENGINE_NAME,
                    AnalysisResult.engine_version == ENGINE_VERSION,
                    AnalysisResult.depth >= min_depth,
                    AnalysisResult.multipv_rank == 1,
                )
            )
            for position_id, depth in depth_rows.all():
                position_id, depth = int(position_id), int(depth)
                depth_by_position[position_id] = max(
                    depth_by_position.get(position_id, 0), depth
                )
            outcome_rows = await session.execute(
                select(PositionOutcome.position_id).where(
                    PositionOutcome.position_id.in_(recent_position_ids)
                )
            )
            exact_position_ids = {int(value) for value in outcome_rows.scalars()}
        return depth_by_position, exact_position_ids

    # The walk above reads the whole library to find sparse middlegame work
    # (~1.5-3s, and the crawler asks every batch), yet between batches the
    # work barely changes: only the positions just searched drop off. So the
    # pool is built once and reused; each request re-checks only its own
    # positions' depths (one small query) and rebuilds when the pool runs low.
    # Imports clear it (`invalidate_improvement_caches`).
    excluded = set(excluded_fens)

    def usable(pairs: list[_DecisionPairTarget]) -> list[_DecisionPairTarget]:
        return [
            pair for pair in pairs
            if pair.parent_fen not in excluded and pair.child_fen not in excluded
        ]

    def with_work(pairs, depth_by_position, exact_position_ids) -> int:
        return sum(
            1 for pair in pairs
            if _pair_work(
                pair, depth_by_position=depth_by_position,
                exact_position_ids=exact_position_ids, min_depth=min_depth,
            )
        )

    pool_key = await cache.versioned_key(
        f"queue-pool:v1:{username}:{color}:{time_class}:{min_depth}:"
        f"{min_user_rating}:{recent_pair_target}"
    )
    cached_pool = await cache.get_json(pool_key)
    pool: list[_DecisionPairTarget] | None = None
    if cached_pool is not None:
        pool = usable([_DecisionPairTarget(**item) for item in cached_pool])
        depth_by_position, exact_position_ids = await load_depths(pool)
        if with_work(pool, depth_by_position, exact_position_ids) < limit * _POOL_REFILL_FACTOR:
            pool = None
    if pool is None:
        built = await build_pool()
        await cache.set_json(
            pool_key, [asdict(pair) for pair in built], ttl_seconds=_POOL_TTL_SECONDS
        )
        pool = usable(built)
        depth_by_position, exact_position_ids = await load_depths(pool)
    recent_pairs = pool
    fens, selected_pair_counts, depth_targets = _phase_balanced_pair_fens(
        recent_pairs,
        depth_by_position=depth_by_position,
        exact_position_ids=exact_position_ids,
        min_depth=min_depth,
        limit=limit,
    )

    # Malformed/partial historical rows cannot form a pair. Preserve the old
    # recent-position walk as a bounded fallback before global recurrence.
    already_selected = set(fens)
    if len(fens) < limit:
        recent_rows = await session.execute(
            select(Position.fen)
            .select_from(Game)
            .join(GamePosition, GamePosition.game_id == Game.id)
            .join(Position, Position.id == GamePosition.position_id)
            .where(
                *filters,
                ~already_analyzed,
                Position.fen.not_in(excluded_fens),
                Position.fen.not_in(fens) if fens else True,
            )
            .order_by(Game.played_at.desc(), Game.id.desc(), GamePosition.ply.asc())
            .limit(max(limit, limit * 4))
        )
        for fen in recent_rows.scalars():
            if fen in already_selected:
                continue
            # Unstorable positions are filtered here rather than offered: the
            # fetch over-reads 4x for exactly this kind of attrition.
            if not _is_storable_fen(fen):
                continue
            fens.append(fen)
            already_selected.add(fen)
            if len(fens) == limit:
                break

    if len(fens) < limit:
        # Once the recent frontier is covered, recurrent positions keep older
        # history moving forward efficiently via positions.total_games.
        fallback = await session.execute(
            select(Position.fen)
            .where(
                Position.total_games >= 1,
                played_by_user,
                ~already_analyzed,
                Position.fen.not_in(excluded_fens),
                Position.fen.not_in(fens) if fens else True,
            )
            .order_by(Position.total_games.desc(), Position.id.asc())
            .limit(limit - len(fens))
        )
        # A short batch is better than a poisoned one: the crawler searches at
        # most what it is offered, and whatever is skipped here is skipped
        # without an engine search rather than with one plus two uploads.
        fens.extend(fen for fen in fallback.scalars().all() if _is_storable_fen(fen))
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


@router.get("/{game_id}", response_model=GameOut)
async def get_game(game_id: int, session: AsyncSession = Depends(get_db)) -> GameOut:
    game = await session.get(Game, game_id)
    if game is None:
        raise HTTPException(status_code=404, detail="Game not found")
    return GameOut.model_validate(game)
