from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import exists, select

from app.database import async_session_factory
from app.models.game import Game
from app.models.game_position import GamePosition
from app.services.pgn_parser import parse_game_pgn
from app.services.improvement import invalidate_improvement_caches
from app.services.tree_builder import backfill_position_clocks_by_game_id


BATCH_SIZE = 100


async def backfill(username: str, time_classes: tuple[str, ...]) -> tuple[int, int]:
    games_processed = 0
    clock_rows_written = 0
    last_game_id = 0

    async with async_session_factory() as session:
        while True:
            missing_clock = exists(
                select(GamePosition.id).where(
                    GamePosition.game_id == Game.id,
                    GamePosition.clock_seconds_after.is_(None),
                    GamePosition.ply > 0,
                )
            )
            rows = (
                await session.execute(
                    select(Game.id, Game.pgn)
                    .where(
                        Game.username == username,
                        Game.time_class.in_(time_classes),
                        Game.id > last_game_id,
                        Game.pgn.contains("[%clk"),
                        missing_clock,
                    )
                    .order_by(Game.id)
                    .limit(BATCH_SIZE)
                )
            ).all()
            if not rows:
                break
            for game_id, pgn in rows:
                parsed = parse_game_pgn(pgn)
                clock_rows_written += await backfill_position_clocks_by_game_id(
                    session, game_id, parsed
                )
                games_processed += 1
                last_game_id = game_id
            await session.commit()

    if clock_rows_written:
        await invalidate_improvement_caches(username)
    return games_processed, clock_rows_written


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill per-move clocks from stored PGNs")
    parser.add_argument("username")
    parser.add_argument(
        "--time-class",
        action="append",
        choices=("rapid", "blitz"),
        dest="time_classes",
    )
    args = parser.parse_args()
    time_classes = tuple(args.time_classes or ("rapid", "blitz"))
    games, rows = asyncio.run(backfill(args.username, time_classes))
    print(f"Backfilled {rows} move clocks across {games} games for {args.username}.")


if __name__ == "__main__":
    main()
