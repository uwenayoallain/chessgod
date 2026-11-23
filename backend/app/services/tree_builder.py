from __future__ import annotations

from sqlalchemy import Float, case, literal, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.models.game_position import GamePosition
from app.models.game import Game
from app.models.game_tree_source import GameTreeSource
from app.models.position import Position
from app.models.position_move import PositionMove
from app.services.pgn_parser import ParsedGame
from app.services.position_outcomes import store_position_outcomes


async def update_tree_from_game(
    session: AsyncSession,
    game_id: int,
    parsed: ParsedGame,
    game_result: str,
) -> None:
    """Upsert the opening tree for one game using a handful of batched
    statements instead of two-plus round-trips per ply.

    All writes are deduplicated within the game first: a position (FEN) or an
    edge ((from_position_id, move_uci)) can recur in a single game via
    repetition/transposition, and a multi-row ``ON CONFLICT DO UPDATE`` cannot
    touch the same target row twice ("cannot affect row a second time"). Dedup
    also makes the per-game stat increment correct: +1 game per distinct
    position/edge, regardless of how many times it occurs in the game.
    """
    if not parsed.positions:
        return

    game_url = await session.scalar(select(Game.chesscom_game_url).where(Game.id == game_id))
    # The unique source claim also serializes simultaneous imports of the two
    # participants. Its rollback follows the tree writes in this transaction.
    counted = await session.scalar(
        pg_insert(GameTreeSource).values(game_url=game_url)
        .on_conflict_do_nothing().returning(GameTreeSource.game_url)
    )
    increment = int(counted is not None)

    white_inc = increment if game_result == "1-0" else 0
    draw_inc = increment if game_result == "1/2-1/2" else 0
    black_inc = increment if game_result == "0-1" else 0

    # Each FEN is written once. The returned ids are keyed by FEN.
    unique_fens = list(dict.fromkeys(record.fen for record in parsed.positions))
    position_stmt = (
        pg_insert(Position)
        .values(
            [
                {
                    "fen": fen,
                    "total_games": increment,
                    "white_wins": white_inc,
                    "draws": draw_inc,
                    "black_wins": black_inc,
                }
                for fen in unique_fens
            ]
        )
        .on_conflict_do_update(
            index_elements=["fen"],
            set_={
                "total_games": Position.total_games + increment,
                "white_wins": Position.white_wins + white_inc,
                "draws": Position.draws + draw_inc,
                "black_wins": Position.black_wins + black_inc,
            },
        )
        .returning(Position.id, Position.fen)
    )
    rows = (await session.execute(position_stmt)).all()
    id_by_fen = {fen: position_id for position_id, fen in rows}
    final_fen = parsed.positions[-1].fen
    await store_position_outcomes(session, [(id_by_fen[final_fen], final_fen)])

    junction_rows = [
        {
            "game_id": game_id,
            "position_id": id_by_fen[record.fen],
            "ply": record.ply,
            "move_san": record.move_san,
            "move_uci": record.move_uci,
            "clock_seconds_after": record.clock_seconds_after,
            "think_seconds": record.think_seconds,
        }
        for record in parsed.positions
    ]
    await session.execute(
        pg_insert(GamePosition).values(junction_rows).on_conflict_do_nothing()
    )

    # Deduplicate edges by (from_position_id, move_uci); keep the first occurrence.
    edges: dict[tuple[int, str], dict] = {}
    for index in range(1, len(parsed.positions)):
        record = parsed.positions[index]
        if record.move_uci is None:
            continue
        from_id = id_by_fen[parsed.positions[index - 1].fen]
        key = (from_id, record.move_uci)
        if key in edges:
            continue
        edges[key] = {
            "from_position_id": from_id,
            "to_position_id": id_by_fen[record.fen],
            "move_san": record.move_san,
            "move_uci": record.move_uci,
            "move_number": record.ply,
            "is_white_move": record.ply % 2 == 1,
            "game_count": increment,
            "white_wins": white_inc,
            "draws": draw_inc,
            "black_wins": black_inc,
        }

    if edges:
        move_stmt = pg_insert(PositionMove).values(list(edges.values()))
        move_stmt = move_stmt.on_conflict_do_update(
            index_elements=["from_position_id", "move_uci"],
            set_={
                "to_position_id": move_stmt.excluded.to_position_id,
                "move_san": move_stmt.excluded.move_san,
                "move_number": move_stmt.excluded.move_number,
                "is_white_move": move_stmt.excluded.is_white_move,
                "game_count": PositionMove.game_count + increment,
                "white_wins": PositionMove.white_wins + white_inc,
                "draws": PositionMove.draws + draw_inc,
                "black_wins": PositionMove.black_wins + black_inc,
            },
        )
        await session.execute(move_stmt)


async def backfill_position_clocks(
    session: AsyncSession,
    game_url: str,
    parsed: ParsedGame,
    username: str | None = None,
) -> int:
    """Fill clock metadata for an already-imported game without rebuilding its tree."""

    clock_rows = [record for record in parsed.positions if record.clock_seconds_after is not None]
    if not clock_rows:
        return 0
    query = select(Game.id).where(Game.chesscom_game_url == game_url)
    if username is not None:
        query = query.where(Game.username == username)
    total = 0
    for game_id in await session.scalars(query):
        total += await backfill_position_clocks_by_game_id(session, game_id, parsed)
    return total


async def backfill_position_clocks_by_game_id(
    session: AsyncSession,
    game_id: int,
    parsed: ParsedGame,
) -> int:
    """Fill missing clocks for matching plies and return the number actually written."""
    game_positions = GamePosition.__table__
    ply = game_positions.c.ply
    records = [r for r in parsed.positions if r.ply > 0 and r.clock_seconds_after is not None]
    written = 0
    # Five parameters per ply. Keep long games under SQLite's bind limit.
    for start in range(0, len(records), 128):
        batch = records[start:start + 128]
        clocks = {r.ply: r.clock_seconds_after for r in batch}
        thinks = {r.ply: literal(r.think_seconds, type_=Float()) for r in batch}
        updated = await session.scalars(
            update(game_positions)
            .where(
                game_positions.c.game_id == game_id,
                game_positions.c.clock_seconds_after.is_(None),
                ply.in_(clocks),
            )
            .values(
                clock_seconds_after=case(clocks, value=ply),
                think_seconds=case(thinks, value=ply),
            )
            .returning(ply)
        )
        written += len(updated.all())
    return written
