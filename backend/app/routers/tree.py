from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_move import PositionMove
from app.schemas.game import GameListOut, GameOut
from app.schemas.tree import MoveOut, TreeNodeOut
from app.services.common_book import is_common_book_move

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

    game_filters = [GamePosition.position_id == position.id]
    game_attr_filters: list = []
    if color != "both":
        game_filters.append(Game.user_color == color)
        game_attr_filters.append(Game.user_color == color)
    if time_class:
        game_filters.append(Game.time_class == time_class)
        game_attr_filters.append(Game.time_class == time_class)

    game_ids_query = (
        select(GamePosition.game_id)
        .join(Game, Game.id == GamePosition.game_id)
        .where(*game_filters)
    )
    game_ids_result = await session.execute(game_ids_query)
    game_ids = game_ids_result.scalars().all()

    if not game_ids:
        return TreeNodeOut(
            fen=position.fen,
            total_games=0,
            white_wins=0,
            draws=0,
            black_wins=0,
            moves=[],
        )

    game_rows = await session.execute(select(Game).where(Game.id.in_(game_ids)))
    games = list(game_rows.scalars().all())
    total_games = len(games)
    white_wins = sum(1 for game in games if game.result == "1-0")
    draws = sum(1 for game in games if game.result == "1/2-1/2")
    black_wins = sum(1 for game in games if game.result == "0-1")

    move_rows = await session.execute(
        select(PositionMove, Position.fen)
        .join(Position, Position.id == PositionMove.to_position_id)
        .where(PositionMove.from_position_id == position.id)
        .order_by(PositionMove.game_count.desc(), PositionMove.move_san.asc())
    )

    moves: list[MoveOut] = []
    for move, resulting_fen in move_rows.all():
        move_game_ids_result = await session.execute(
            select(GamePosition.game_id)
            .join(Game, Game.id == GamePosition.game_id)
            .where(
                GamePosition.position_id == move.to_position_id,
                GamePosition.move_uci == move.move_uci,
                GamePosition.ply == move.move_number,
                *game_attr_filters,
            )
        )
        move_game_ids = move_game_ids_result.scalars().all()
        if not move_game_ids:
            continue

        move_games = await session.execute(
            select(Game).where(Game.id.in_(move_game_ids))
        )
        move_game_rows = list(move_games.scalars().all())
        move_white_wins = sum(1 for game in move_game_rows if game.result == "1-0")
        move_draws = sum(1 for game in move_game_rows if game.result == "1/2-1/2")
        move_black_wins = sum(1 for game in move_game_rows if game.result == "0-1")

        moves.append(
            MoveOut(
                san=move.move_san,
                uci=move.move_uci,
                game_count=len(move_game_rows),
                white_wins=move_white_wins,
                draws=move_draws,
                black_wins=move_black_wins,
                avg_opponent_rating=move.avg_opponent_rating,
                resulting_fen=resulting_fen,
                is_book_move=bool(move.master_game_count)
                or is_common_book_move(position.fen, move.move_uci, move.move_san),
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
        white_wins=white_wins,
        draws=draws,
        black_wins=black_wins,
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
