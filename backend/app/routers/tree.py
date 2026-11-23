from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.database import get_db
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_move import PositionMove
from app.schemas.game import GameListOut, GameOut
from app.schemas.tree import MoveOut, TreeNodeOut
from app.services.common_book import common_book_move_keys
from app.services.game_scope import time_class_condition

router = APIRouter()


@router.get("/position", response_model=TreeNodeOut)
async def get_position_tree(
    fen: str = Query(...),
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    session: AsyncSession = Depends(get_db),
) -> TreeNodeOut:
    result = await session.execute(select(Position).where(Position.fen == fen))
    position = result.scalar_one_or_none()
    if position is None:
        return TreeNodeOut(
            fen=fen, total_games=0, white_wins=0, draws=0, black_wins=0, moves=[]
        )

    game_join_filters = []
    if color != "both":
        game_join_filters.append(Game.user_color == color)
    time_filter = time_class_condition(Game.time_class, time_class)
    if time_filter is not None:
        game_join_filters.append(time_filter)

    # Fast path: when there are no per-game filters, tree_builder keeps
    # Position.total_games / white_wins / draws / black_wins accurate via
    # upsert, so we skip both aggregate JOIN queries entirely.
    if not game_join_filters:
        total_games = position.total_games or 0
        white_wins = position.white_wins or 0
        draws = position.draws or 0
        black_wins = position.black_wins or 0
        if not total_games:
            return TreeNodeOut(fen=position.fen, total_games=0, white_wins=0, draws=0, black_wins=0, moves=[])

        book_ucis, book_sans = await asyncio.to_thread(common_book_move_keys, position.fen)
        fast_rows = await session.execute(
            select(PositionMove, Position.fen)
            .join(Position, Position.id == PositionMove.to_position_id)
            .where(PositionMove.from_position_id == position.id, PositionMove.game_count > 0)
            .order_by(PositionMove.game_count.desc(), PositionMove.move_san.asc())
            .limit(60)
        )
        moves = [
            MoveOut(
                san=m.move_san,
                uci=m.move_uci,
                game_count=m.game_count,
                white_wins=m.white_wins,
                draws=m.draws,
                black_wins=m.black_wins,
                avg_opponent_rating=m.avg_opponent_rating,
                resulting_fen=resulting_fen,
                is_book_move=bool(m.master_game_count)
                or m.move_uci in book_ucis
                or m.move_san in book_sans,
                master_game_count=m.master_game_count,
                master_white_wins=m.master_white_wins,
                master_draws=m.master_draws,
                master_black_wins=m.master_black_wins,
            )
            for m, resulting_fen in fast_rows.all()
        ]
        moves.sort(key=lambda row: (-row.game_count, row.san))
        return TreeNodeOut(
            fen=position.fen, total_games=total_games,
            white_wins=white_wins, draws=draws, black_wins=black_wins, moves=moves,
        )

    # Filtered path (color or time_class specified): aggregate from games.
    #
    # Everything here is counted in games, once each. A game that comes back
    # to a position (a repetition, a transposition inside one game) has a
    # game_positions row per visit, and counting rows read it as that many
    # games.
    visits_position = (
        select(GamePosition.id)
        .where(GamePosition.game_id == Game.id, GamePosition.position_id == position.id)
        .exists()
    )
    stats_row = await session.execute(
        select(
            func.count(),
            func.sum(case((Game.result == "1-0", 1), else_=0)),
            func.sum(case((Game.result == "1/2-1/2", 1), else_=0)),
            func.sum(case((Game.result == "0-1", 1), else_=0)),
        )
        .select_from(Game)
        .where(visits_position, *game_join_filters)
    )
    total_games, white_wins, draws, black_wins = stats_row.one()

    if not total_games:
        return TreeNodeOut(fen=position.fen, total_games=0, white_wins=0, draws=0, black_wins=0, moves=[])

    # A move is an edge of the game it was played in: the row at this position
    # and the row one ply later in the same game. Matching every game_positions
    # row that reached the child by this move at the one ply stored on
    # position_moves missed the same move played from here at any other ply,
    # and counted games that reached the child from somewhere else.
    parent_gp = aliased(GamePosition)
    child_gp = aliased(GamePosition)
    opponent_rating = case(
        (Game.user_color == "white", Game.black_rating),
        else_=Game.white_rating,
    )
    # One row per game and move, so a game that plays the move twice from here
    # is one game. Filtered here, before anything is counted.
    played = (
        select(
            parent_gp.game_id.label("game_id"),
            child_gp.move_uci.label("move_uci"),
            func.min(child_gp.position_id).label("to_position_id"),
            func.min(child_gp.move_san).label("move_san"),
            func.min(Game.result).label("result"),
            func.min(opponent_rating).label("opponent_rating"),
        )
        .select_from(parent_gp)
        .join(
            child_gp,
            and_(child_gp.game_id == parent_gp.game_id, child_gp.ply == parent_gp.ply + 1),
        )
        .join(Game, Game.id == parent_gp.game_id)
        .where(
            parent_gp.position_id == position.id,
            child_gp.move_uci.is_not(None),
            *game_join_filters,
        )
        .group_by(parent_gp.game_id, child_gp.move_uci)
        .subquery()
    )
    edges = (
        select(
            played.c.move_uci,
            func.min(played.c.to_position_id).label("to_position_id"),
            func.min(played.c.move_san).label("move_san"),
            func.count().label("game_count"),
            func.sum(case((played.c.result == "1-0", 1), else_=0)).label("white_wins"),
            func.sum(case((played.c.result == "1/2-1/2", 1), else_=0)).label("draws"),
            func.sum(case((played.c.result == "0-1", 1), else_=0)).label("black_wins"),
            func.avg(played.c.opponent_rating).label("avg_opponent_rating"),
        )
        .group_by(played.c.move_uci)
        .subquery()
    )
    edge_san = func.coalesce(PositionMove.move_san, edges.c.move_san, edges.c.move_uci)
    # Ranked by the games the filter kept, then cut. Ranked by the unfiltered
    # count on position_moves, the sixty moves kept were everyone's most
    # played, and a move this colour or time control plays often could fall
    # outside them.
    move_rows = await session.execute(
        select(edges, edge_san.label("san"), Position.fen, PositionMove)
        .join(Position, Position.id == edges.c.to_position_id)
        .outerjoin(
            PositionMove,
            and_(
                PositionMove.from_position_id == position.id,
                PositionMove.move_uci == edges.c.move_uci,
            ),
        )
        .order_by(edges.c.game_count.desc(), edge_san.asc())
        .limit(60)
    )

    book_ucis, book_sans = await asyncio.to_thread(common_book_move_keys, position.fen)
    moves = []
    for row in move_rows.all():
        # Master counts live on position_moves; a move played here that has no
        # row there yet is still a move played here.
        master = row.PositionMove
        avg_rating = row.avg_opponent_rating
        moves.append(
            MoveOut(
                san=row.san,
                uci=row.move_uci,
                game_count=row.game_count,
                white_wins=row.white_wins or 0,
                draws=row.draws or 0,
                black_wins=row.black_wins or 0,
                # Over the filtered games, like every other number on the move.
                avg_opponent_rating=None if avg_rating is None else round(float(avg_rating), 1),
                resulting_fen=row.fen,
                is_book_move=bool(master is not None and master.master_game_count)
                or row.move_uci in book_ucis
                or row.san in book_sans,
                master_game_count=None if master is None else master.master_game_count,
                master_white_wins=None if master is None else master.master_white_wins,
                master_draws=None if master is None else master.master_draws,
                master_black_wins=None if master is None else master.master_black_wins,
            )
        )

    moves.sort(key=lambda row: (-row.game_count, row.san))

    return TreeNodeOut(
        fen=position.fen,
        total_games=total_games,
        white_wins=white_wins or 0,
        draws=draws or 0,
        black_wins=black_wins or 0,
        moves=moves,
    )


@router.get("/games", response_model=GameListOut)
async def get_games_for_position(
    fen: str = Query(...),
    page: Annotated[int, Query(ge=1)] = 1,
    per_page: Annotated[int, Query(ge=1, le=200)] = 50,
    session: AsyncSession = Depends(get_db),
) -> GameListOut:
    position_id = await session.scalar(select(Position.id).where(Position.fen == fen))
    if position_id is None:
        return GameListOut(games=[], total=0, page=page, per_page=per_page)

    # Games, not visits: a game that reaches the position twice is one game in
    # the total and one row in the list. The page is cut from the games in
    # their final order (newest first, id to break ties), where it used to be
    # cut from game_positions in whatever order the rows came back and only
    # then sorted, so a page was an arbitrary slice with repeats in it.
    visits_position = (
        select(GamePosition.id)
        .where(GamePosition.game_id == Game.id, GamePosition.position_id == position_id)
        .exists()
    )
    total = await session.scalar(select(func.count()).select_from(Game).where(visits_position))
    # Ids first: the sort then carries two narrow columns instead of every
    # matching game's PGN.
    game_ids = (
        await session.execute(
            select(Game.id)
            .where(visits_position)
            .order_by(Game.played_at.desc(), Game.id.desc())
            .offset((page - 1) * per_page)
            .limit(per_page)
        )
    ).scalars().all()
    if not game_ids:
        return GameListOut(games=[], total=total or 0, page=page, per_page=per_page)

    games_result = await session.execute(
        select(Game).where(Game.id.in_(game_ids)).order_by(Game.played_at.desc(), Game.id.desc())
    )
    games = [GameOut.model_validate(game) for game in games_result.scalars().all()]
    return GameListOut(games=games, total=total or 0, page=page, per_page=per_page)
