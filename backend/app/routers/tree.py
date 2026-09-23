from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

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
    stats_row = await session.execute(
        select(
            func.count(Game.id),
            func.sum(case((Game.result == "1-0", 1), else_=0)),
            func.sum(case((Game.result == "1/2-1/2", 1), else_=0)),
            func.sum(case((Game.result == "0-1", 1), else_=0)),
        )
        .select_from(GamePosition)
        .join(Game, Game.id == GamePosition.game_id)
        .where(GamePosition.position_id == position.id, *game_join_filters)
    )
    total_games, white_wins, draws, black_wins = stats_row.one()

    if not total_games:
        return TreeNodeOut(fen=position.fen, total_games=0, white_wins=0, draws=0, black_wins=0, moves=[])

    move_rows = await session.execute(
        select(
            PositionMove,
            Position.fen,
            func.count(Game.id),
            func.sum(case((Game.result == "1-0", 1), else_=0)),
            func.sum(case((Game.result == "1/2-1/2", 1), else_=0)),
            func.sum(case((Game.result == "0-1", 1), else_=0)),
        )
        .join(Position, Position.id == PositionMove.to_position_id)
        .outerjoin(
            GamePosition,
            and_(
                GamePosition.position_id == PositionMove.to_position_id,
                GamePosition.move_uci == PositionMove.move_uci,
                GamePosition.ply == PositionMove.move_number,
            ),
        )
        .outerjoin(Game, and_(Game.id == GamePosition.game_id, *game_join_filters))
        .where(PositionMove.from_position_id == position.id)
        .group_by(PositionMove.id, Position.fen)
        .order_by(PositionMove.game_count.desc(), PositionMove.move_san.asc())
        .limit(60)
    )

    book_ucis, book_sans = await asyncio.to_thread(common_book_move_keys, position.fen)
    moves = []
    for move, resulting_fen, move_total, move_white_wins, move_draws, move_black_wins in move_rows.all():
        if not move_total:
            continue

        moves.append(
            MoveOut(
                san=move.move_san,
                uci=move.move_uci,
                game_count=move_total,
                white_wins=move_white_wins or 0,
                draws=move_draws or 0,
                black_wins=move_black_wins or 0,
                avg_opponent_rating=move.avg_opponent_rating,
                resulting_fen=resulting_fen,
                is_book_move=bool(move.master_game_count)
                or move.move_uci in book_ucis
                or move.move_san in book_sans,
                master_game_count=move.master_game_count,
                master_white_wins=move.master_white_wins,
                master_draws=move.master_draws,
                master_black_wins=move.master_black_wins,
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
    page: int = 1,
    per_page: int = 50,
    session: AsyncSession = Depends(get_db),
) -> GameListOut:
    position = await session.scalar(select(Position).where(Position.fen == fen))
    if position is None:
        return GameListOut(games=[], total=0, page=page, per_page=per_page)

    game_ids_result = await session.execute(
        select(GamePosition.game_id)
        .where(GamePosition.position_id == position.id)
        .offset((page - 1) * per_page)
        .limit(per_page)
    )
    game_ids = [value for value in game_ids_result.scalars().all()]
    total = await session.scalar(
        select(func.count())
        .select_from(GamePosition)
        .where(GamePosition.position_id == position.id)
    )
    if not game_ids:
        return GameListOut(games=[], total=total or 0, page=page, per_page=per_page)

    games_result = await session.execute(
        select(Game).where(Game.id.in_(game_ids)).order_by(Game.played_at.desc())
    )
    games = [GameOut.model_validate(game) for game in games_result.scalars().all()]
    return GameListOut(games=games, total=total or 0, page=page, per_page=per_page)
