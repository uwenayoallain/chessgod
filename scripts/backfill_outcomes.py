"""Idempotently derive terminal board facts from imported games, without an engine."""

import argparse
import asyncio
import json

from sqlalchemy import func, select

from app.database import async_session_factory, engine
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.services.improvement import invalidate_improvement_caches_for_positions
from app.services.position_outcomes import store_position_outcomes


async def backfill(username: str) -> dict[str, int]:
    cursor = checked = stored = 0
    async with async_session_factory() as session:
        while True:
            ids = list(await session.scalars(
                select(Game.id).where(Game.username == username, Game.id > cursor)
                .order_by(Game.id).limit(200)
            ))
            if not ids:
                break
            finals = select(GamePosition.game_id, func.max(GamePosition.ply).label("ply")).where(
                GamePosition.game_id.in_(ids)
            ).group_by(GamePosition.game_id).subquery()
            positions = (await session.execute(
                select(Position.id, Position.fen).join(GamePosition, GamePosition.position_id == Position.id)
                .join(finals, (finals.c.game_id == GamePosition.game_id) & (finals.c.ply == GamePosition.ply))
            )).all()
            added = await store_position_outcomes(session, positions)
            await session.commit()
            if added:
                await invalidate_improvement_caches_for_positions(session, {row.id for row in positions})
            stored += added
            checked += len(positions)
            cursor = ids[-1]
    await engine.dispose()
    return {"final_positions_checked": checked, "outcomes_added": stored}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("username")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(backfill(args.username.lower())), indent=2))
