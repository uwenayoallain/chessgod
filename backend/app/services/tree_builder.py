from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_move import PositionMove
from app.services.pgn_parser import ParsedGame


async def update_tree_from_game(
    session: AsyncSession,
    game_id: int,
    parsed: ParsedGame,
    game_result: str,
) -> None:
    white_inc = 1 if game_result == "1-0" else 0
    draw_inc = 1 if game_result == "1/2-1/2" else 0
    black_inc = 1 if game_result == "0-1" else 0

    position_ids: list[int] = []

    for record in parsed.positions:
        position_stmt = (
            pg_insert(Position)
            .values(
                fen=record.fen,
                total_games=1,
                white_wins=white_inc,
                draws=draw_inc,
                black_wins=black_inc,
            )
            .on_conflict_do_update(
                index_elements=["fen"],
                set_={
                    "total_games": Position.total_games + 1,
                    "white_wins": Position.white_wins + white_inc,
                    "draws": Position.draws + draw_inc,
                    "black_wins": Position.black_wins + black_inc,
                },
            )
            .returning(Position.id)
        )
        result = await session.execute(position_stmt)
        position_id = result.scalar_one()
        position_ids.append(position_id)

        junction_stmt = (
            pg_insert(GamePosition)
            .values(
                game_id=game_id,
                position_id=position_id,
                ply=record.ply,
                move_san=record.move_san,
                move_uci=record.move_uci,
            )
            .on_conflict_do_nothing()
        )
        await session.execute(junction_stmt)

    for index in range(1, len(parsed.positions)):
        record = parsed.positions[index]
        move_stmt = (
            pg_insert(PositionMove)
            .values(
                from_position_id=position_ids[index - 1],
                to_position_id=position_ids[index],
                move_san=record.move_san,
                move_uci=record.move_uci,
                move_number=record.ply,
                is_white_move=record.ply % 2 == 1,
                game_count=1,
                white_wins=white_inc,
                draws=draw_inc,
                black_wins=black_inc,
            )
            .on_conflict_do_update(
                index_elements=["from_position_id", "move_uci"],
                set_={
                    "to_position_id": position_ids[index],
                    "move_san": record.move_san,
                    "move_number": record.ply,
                    "is_white_move": record.ply % 2 == 1,
                    "game_count": PositionMove.game_count + 1,
                    "white_wins": PositionMove.white_wins + white_inc,
                    "draws": PositionMove.draws + draw_inc,
                    "black_wins": PositionMove.black_wins + black_inc,
                },
            )
        )
        await session.execute(move_stmt)
