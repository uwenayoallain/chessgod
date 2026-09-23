from __future__ import annotations

import asyncio
from typing import Annotated

from datetime import UTC

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.opening_family import OpeningFamily
from app.models.position import Position
from app.models.position_move import PositionMove
from app.schemas.theory import (
    DeviationOut,
    FamilyDetailOut,
    FamilySummaryOut,
    MistakeOut,
    RepertoireMarkIn,
    RepertoireMarkOut,
    RepertoireTreeOut,
    TheoryComparisonOut,
    TheoryMove,
    TrainingLineOut,
    TrainingMoveOut,
)
from app.schemas.tree import TreeNodeOut
from app.routers.tree import get_position_tree
from app.services.opening_families import (
    family_child_counts,
    family_user_stats,
    family_user_stats_bulk,
)
from app.services.mistakes import find_mistakes_cached
from app.services.game_scope import time_class_condition
from app.services.repertoire import delete_repertoire_mark, derive_repertoire, upsert_repertoire_mark
from app.services.pgn_parser import parse_game_pgn
from app.services.theory import (
    DEFAULT_CANDIDATE_POSITION_LIMIT,
    build_deep_training_line,
    build_training_line_from_parsed_game,
    build_deviation,
    build_seeded_deviation,
    get_local_master_data,
    load_candidate_positions,
    load_moves_for_position,
    load_position_by_fen,
    master_data_state,
    serialize_master_move,
    serialize_user_move,
)
from app.services.common_book import get_common_book_moves
from app.services.swr import stale_while_revalidate

router = APIRouter()


def empty_master_data() -> dict:
    return {"white": 0, "draws": 0, "black": 0, "opening": {}, "moves": []}


async def family_summary(
    session: AsyncSession,
    family: OpeningFamily,
    *,
    username: str | None,
    color: str,
    time_class: str | None,
) -> FamilySummaryOut:
    child_count = await session.scalar(
        select(func.count()).select_from(OpeningFamily).where(OpeningFamily.parent_id == family.id)
    )
    stats = await family_user_stats(session, family.id, username, color, time_class)
    return FamilySummaryOut(
        id=family.id,
        parent_id=family.parent_id,
        full_name=family.full_name,
        display_name=family.display_name,
        eco=family.eco,
        root_fen=family.root_fen,
        pgn=family.pgn,
        depth=family.depth,
        is_main_line=family.is_main_line,
        child_count=child_count or 0,
        user_game_count=int(stats["game_count"]),
        user_win_rate=float(stats["win_rate"]),
    )


async def family_summaries_bulk(
    session: AsyncSession,
    families: list[OpeningFamily],
    *,
    username: str | None,
    color: str,
    time_class: str | None,
) -> list[FamilySummaryOut]:
    if not families:
        return []
    family_ids = [f.id for f in families]
    child_counts = await family_child_counts(session, family_ids)
    stats_by_id = await family_user_stats_bulk(
        session, families, username, color, time_class
    )
    return [
        FamilySummaryOut(
            id=family.id,
            parent_id=family.parent_id,
            full_name=family.full_name,
            display_name=family.display_name,
            eco=family.eco,
            root_fen=family.root_fen,
            pgn=family.pgn,
            depth=family.depth,
            is_main_line=family.is_main_line,
            child_count=child_counts.get(family.id, 0),
            user_game_count=int(stats_by_id[family.id]["game_count"]),
            user_win_rate=float(stats_by_id[family.id]["win_rate"]),
        )
        for family in families
    ]


async def family_ancestors(session: AsyncSession, family: OpeningFamily) -> list[OpeningFamily]:
    ancestors: list[OpeningFamily] = []
    current = family
    while current.parent_id is not None:
        parent = await session.get(OpeningFamily, current.parent_id)
        if parent is None:
            break
        ancestors.append(parent)
        current = parent
    ancestors.reverse()
    return ancestors


async def find_representative_deviation_game(
    session: AsyncSession,
    moves: list[PositionMove],
    user_top_move: dict,
) -> dict:
    matching_move = next(
        (
            move
            for move in moves
            if (
                user_top_move.get("uci")
                and move.move_uci == user_top_move.get("uci")
            )
            or move.move_san == user_top_move.get("san")
        ),
        None,
    )
    if matching_move is None:
        return {}

    result = await session.execute(
        select(Game, GamePosition, Position.fen)
        .join(GamePosition, GamePosition.game_id == Game.id)
        .join(Position, Position.id == GamePosition.position_id)
        .where(
            GamePosition.position_id == matching_move.to_position_id,
            GamePosition.ply == matching_move.move_number,
            GamePosition.move_uci == matching_move.move_uci,
        )
        .order_by(Game.played_at.desc(), Game.id.desc())
        .limit(1)
    )
    row = result.first()
    if row is None:
        return {}

    game, game_position, post_fen = row
    played_at = game.played_at
    if played_at.tzinfo is None:
        played_at = played_at.replace(tzinfo=UTC)
    return {
        "representative_game_id": game.id,
        "representative_game_ply": game_position.ply,
        "representative_post_fen": post_fen,
        "representative_played_at": played_at,
        "representative_user_result": game.user_result,
    }


async def find_representative_deviation_games(
    session: AsyncSession,
    requests: list[tuple[list[PositionMove], dict]],
) -> list[dict]:
    """Resolve representative games for all deviations with one bounded query."""

    request_targets: list[tuple[int, int, str] | None] = []
    for moves, user_top_move in requests:
        matching_move = next(
            (
                move
                for move in moves
                if (
                    user_top_move.get("uci")
                    and move.move_uci == user_top_move.get("uci")
                )
                or move.move_san == user_top_move.get("san")
            ),
            None,
        )
        request_targets.append(
            (
                matching_move.to_position_id,
                matching_move.move_number,
                matching_move.move_uci,
            )
            if matching_move is not None
            else None
        )

    targets = [target for target in request_targets if target is not None]

    if not targets:
        return [{} for _ in request_targets]

    # Rank narrow scalar rows in SQL. Loading ORM Game objects here transfers
    # every matching game's PGN just to discard all but one example per target.
    ranked = (
        select(
            Game.id.label("game_id"),
            Game.played_at,
            Game.user_result,
            GamePosition.position_id,
            GamePosition.ply,
            GamePosition.move_uci,
            func.row_number().over(
                partition_by=(GamePosition.position_id, GamePosition.ply, GamePosition.move_uci),
                order_by=(Game.played_at.desc(), Game.id.desc()),
            ).label("rank"),
        )
        .join(GamePosition, GamePosition.game_id == Game.id)
        .where(
            tuple_(GamePosition.position_id, GamePosition.ply, GamePosition.move_uci).in_(
                list(set(targets))
            )
        )
        .subquery()
    )
    rows = await session.execute(
        select(ranked, Position.fen)
        .join(Position, Position.id == ranked.c.position_id)
        .where(ranked.c.rank == 1)
    )
    representatives: dict[tuple[int, int, str], dict] = {}
    for row in rows:
        key = (row.position_id, row.ply, row.move_uci)
        played_at = row.played_at
        if played_at.tzinfo is None:
            played_at = played_at.replace(tzinfo=UTC)
        representatives[key] = {
            "representative_game_id": row.game_id,
            "representative_game_ply": row.ply,
            "representative_post_fen": row.fen,
            "representative_played_at": played_at,
            "representative_user_result": row.user_result,
        }

    return [
        representatives.get(target, {}) if target is not None else {}
        for target in request_targets
    ]


@router.get("/compare", response_model=TheoryComparisonOut)
async def theory_compare(
    fen: str = Query(...),
    session: AsyncSession = Depends(get_db),
) -> TheoryComparisonOut:
    position = await load_position_by_fen(session, fen)
    user_moves = []
    master_data = empty_master_data()
    color = "white"
    data_state = "missing"
    if position is not None:
        user_moves = await load_moves_for_position(session, position.id)
        color = "white" if user_moves and user_moves[0].is_white_move else "black"
        data_state = master_data_state(position, user_moves)
        master_data = get_local_master_data(position, user_moves)

    combined_master_moves: list[dict] = list(master_data.get("moves", []))
    combined_move_ucis = {
        move.get("uci") for move in combined_master_moves if move.get("uci")
    }
    combined_move_sans = {
        move.get("san") for move in combined_master_moves if move.get("san")
    }
    for book_move in await asyncio.to_thread(get_common_book_moves, fen):
        uci = book_move.get("uci")
        san = book_move.get("san")
        if (uci and uci in combined_move_ucis) or (san and san in combined_move_sans):
            continue
        combined_master_moves.append(
            {
                "san": san,
                "uci": uci,
                "white": 0,
                "draws": 0,
                "black": 0,
            }
        )
        if uci:
            combined_move_ucis.add(uci)
        if san:
            combined_move_sans.add(san)

    return TheoryComparisonOut(
        fen=fen,
        user_moves=[
            TheoryMove(
                san=move["san"],
                uci=move["uci"],
                game_count=move["game_count"],
                win_rate=move["win_rate"],
            )
            for move in [serialize_user_move(move, color) for move in user_moves]
        ],
        master_moves=[
            TheoryMove(
                san=move["san"],
                uci=move.get("uci"),
                game_count=move["game_count"],
                win_rate=move["win_rate"],
            )
            for move in [
                serialize_master_move(move, color) for move in combined_master_moves
            ]
        ],
        eco=master_data.get("opening", {}).get("eco"),
        opening_name=master_data.get("opening", {}).get("name"),
        master_data_state=data_state,
    )


@router.get("/families", response_model=list[FamilySummaryOut])
async def theory_families(
    username: str | None = None,
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    parent_id: int | None = None,
    session: AsyncSession = Depends(get_db),
) -> list[FamilySummaryOut]:
    query = select(OpeningFamily)
    if parent_id is None:
        query = query.where(OpeningFamily.parent_id.is_(None))
    else:
        query = query.where(OpeningFamily.parent_id == parent_id)
    result = await session.execute(
        query.order_by(OpeningFamily.is_main_line.desc(), OpeningFamily.display_name.asc())
    )
    return await family_summaries_bulk(
        session,
        list(result.scalars().all()),
        username=username,
        color=color,
        time_class=time_class,
    )


@router.get("/families/{family_id}", response_model=FamilyDetailOut)
async def get_family_detail(
    family_id: int,
    username: str | None = None,
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    include_mistakes: bool = False,
    session: AsyncSession = Depends(get_db),
) -> FamilyDetailOut:
    family = await session.get(OpeningFamily, family_id)
    if family is None:
        raise HTTPException(status_code=404, detail="Opening family not found")

    child_result = await session.execute(
        select(OpeningFamily)
        .where(OpeningFamily.parent_id == family.id)
        .order_by(OpeningFamily.is_main_line.desc(), OpeningFamily.display_name.asc())
    )
    ancestors = await family_ancestors(session, family)
    position_tree = await get_position_tree(
        fen=family.root_fen,
        color=color,
        time_class=time_class,
        session=session,
    )
    if not isinstance(position_tree, TreeNodeOut):
        position_tree = TreeNodeOut(
            fen=family.root_fen,
            total_games=0,
            white_wins=0,
            draws=0,
            black_wins=0,
            moves=[],
        )

    children_list = list(child_result.scalars().all())
    summaries = await family_summaries_bulk(
        session,
        [family, *ancestors, *children_list],
        username=username,
        color=color,
        time_class=time_class,
    )
    summary_by_id = {summary.id: summary for summary in summaries}

    return FamilyDetailOut(
        family=summary_by_id[family.id],
        ancestors=[summary_by_id[ancestor.id] for ancestor in ancestors],
        children=[summary_by_id[child.id] for child in children_list],
        position_tree=position_tree,
        top_mistakes=await find_mistakes_cached(
            session,
            username,
            color=color,
            time_class=time_class,
            family_id=family.id,
            min_occurrences=1,
        ) if username and include_mistakes else [],
    )


@router.get("/deviations", response_model=list[DeviationOut])
async def theory_deviations(
    color: str = Query(..., pattern="^(white|black)$"),
    min_games: int = Query(5, ge=1),
    limit: Annotated[int, Query(ge=1, le=5_000)] = DEFAULT_CANDIDATE_POSITION_LIMIT,
    session: AsyncSession = Depends(get_db),
) -> list[DeviationOut]:
    # ~0.2s warm and ~0.7s cold, and nothing it reads changes between imports
    # except master data, so the last list is served while a new one builds.
    suffix = f"{color}:{min_games}:{limit}"

    async def compute(db: AsyncSession) -> list[dict]:
        found = await _find_deviations(db, color=color, min_games=min_games, limit=limit)
        return [deviation.model_dump(mode="json") for deviation in found]

    payload = await stale_while_revalidate(
        session,
        fresh_base=f"deviations:v1:{suffix}",
        last_key=f"deviations:last:{suffix}",
        compute=compute,
        fresh_ttl=_DEVIATIONS_TTL_SECONDS,
    )
    return [DeviationOut.model_validate(item) for item in payload]


_DEVIATIONS_TTL_SECONDS = 300.0


async def _find_deviations(
    session: AsyncSession, *, color: str, min_games: int, limit: int
) -> list[DeviationOut]:
    candidates = await load_candidate_positions(
        session, color=color, min_games=min_games, limit=limit
    )
    deviations: list[DeviationOut] = []
    representative_requests: list[tuple[list[PositionMove], dict]] = []

    for position, moves in candidates:
        data_state = master_data_state(position, moves)
        if data_state == "missing":
            continue
        user_moves = [serialize_user_move(move, color) for move in moves]
        master_data = get_local_master_data(position, moves)
        master_moves = [
            serialize_master_move(move, color) for move in master_data.get("moves", [])
        ]
        deviation_builder = build_deviation if data_state == "synced" else build_seeded_deviation
        deviation = deviation_builder(
            fen=position.fen,
            user_moves=user_moves,
            master_moves=master_moves,
            eco=master_data.get("opening", {}).get("eco"),
            opening_name=master_data.get("opening", {}).get("name"),
        )
        if deviation is not None:
            deviations.append(DeviationOut.model_validate(deviation))
            representative_requests.append((moves, user_moves[0]))

    representatives = await find_representative_deviation_games(
        session, representative_requests
    )
    return [
        deviation.model_copy(update=representative)
        for deviation, representative in zip(deviations, representatives, strict=True)
    ]


@router.get("/mistakes", response_model=list[MistakeOut])
async def theory_mistakes(
    username: str = Query(...),
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    family_id: int | None = None,
    min_occurrences: int = Query(2, ge=1),
    threshold_cp: int = Query(50, ge=0),
    session: AsyncSession = Depends(get_db),
) -> list[MistakeOut]:
    return await find_mistakes_cached(
        session,
        username,
        color=color,
        time_class=time_class,
        family_id=family_id,
        min_occurrences=min_occurrences,
        threshold_cp=threshold_cp,
    )


@router.get("/repertoire", response_model=RepertoireTreeOut)
async def theory_repertoire(
    username: str = Query(...),
    color: str = Query(..., pattern="^(white|black)$"),
    session: AsyncSession = Depends(get_db),
) -> RepertoireTreeOut:
    return await derive_repertoire(session, username, color)


@router.post("/repertoire/mark", response_model=RepertoireMarkOut)
async def mark_repertoire(
    payload: RepertoireMarkIn,
    session: AsyncSession = Depends(get_db),
) -> RepertoireMarkOut:
    mark = await upsert_repertoire_mark(session, payload)
    await session.commit()
    return mark


@router.delete("/repertoire/mark", status_code=204)
async def unmark_repertoire(
    username: str = Query(...),
    fen: str = Query(...),
    color: str = Query(..., pattern="^(white|black)$"),
    session: AsyncSession = Depends(get_db),
) -> Response:
    await delete_repertoire_mark(session, username=username, fen=fen, color=color)
    await session.commit()
    return Response(status_code=204)


@router.get("/eco")
async def theory_eco(
    fen: str = Query(...),
    session: AsyncSession = Depends(get_db),
) -> dict[str, str | None]:
    position = await load_position_by_fen(session, fen)
    if position is None:
        raise HTTPException(status_code=404, detail="Opening not found")
    data = get_local_master_data(position, await load_moves_for_position(session, position.id))
    opening = data.get("opening")
    if not opening:
        raise HTTPException(status_code=404, detail="Opening not found")
    return {"eco": opening.get("eco"), "name": opening.get("name")}


@router.get("/training-line", response_model=TrainingLineOut)
async def theory_training_line(
    username: str = Query(...),
    opening_name: str = Query(...),
    eco: str | None = None,
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    session: AsyncSession = Depends(get_db),
) -> TrainingLineOut:
    stmt = select(Game).where(
        Game.username == username, Game.opening_name == opening_name
    )
    if eco:
        stmt = stmt.where(Game.eco == eco)
    if color != "both":
        stmt = stmt.where(Game.user_color == color)
    time_filter = time_class_condition(Game.time_class, time_class)
    if time_filter is not None:
        stmt = stmt.where(time_filter)

    game = await session.scalar(
        stmt.order_by(Game.played_at.desc(), Game.id.desc()).limit(1)
    )
    if game is None:
        raise HTTPException(status_code=404, detail="Training line not found")

    moves = await build_deep_training_line(session)
    if not moves:
        parsed = parse_game_pgn(game.pgn)
        moves = await build_training_line_from_parsed_game(session, parsed)
    if not moves:
        raise HTTPException(
            status_code=404, detail="No master-theory line found for this opening"
        )

    return TrainingLineOut(
        eco=game.eco,
        opening_name=game.opening_name or opening_name,
        source_game_id=game.id,
        moves=[TrainingMoveOut.model_validate(move) for move in moves],
    )
