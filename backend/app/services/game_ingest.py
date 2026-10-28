from __future__ import annotations

from sqlalchemy import update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game


def _insert_for_session(session: AsyncSession):
    bind = session.bind
    if bind is not None and bind.dialect.name == "sqlite":
        return sqlite_insert
    return pg_insert


async def insert_game(session: AsyncSession, game: Game) -> int | None:
    insert_stmt = _insert_for_session(session)
    stmt = (
        insert_stmt(Game)
        .values(
            chesscom_game_url=game.chesscom_game_url,
            chesscom_game_id=game.chesscom_game_id,
            username=game.username.lower(),
            white_username=game.white_username,
            black_username=game.black_username,
            user_color=game.user_color,
            result=game.result,
            user_result=game.user_result,
            time_class=game.time_class,
            time_control=game.time_control,
            white_rating=game.white_rating,
            black_rating=game.black_rating,
            pgn=game.pgn,
            eco=game.eco,
            opening_name=game.opening_name,
            played_at=game.played_at,
            num_moves=game.num_moves,
            termination=game.termination,
        )
        .on_conflict_do_nothing(index_elements=["chesscom_game_url", "username"])
        .returning(Game.id)
    )

    # ON CONFLICT DO NOTHING ... RETURNING yields no row when the game already
    # exists. Older imports predate termination capture, so opportunistically
    # backfill that one derived field when an archive is fetched again while
    # retaining the None return that tells callers not to rebuild the tree.
    inserted_id = await session.scalar(stmt)
    if inserted_id is None and game.termination is not None:
        await session.execute(
            update(Game)
            .where(
                Game.chesscom_game_url == game.chesscom_game_url,
                Game.username == game.username,
                Game.termination.is_(None),
            )
            .values(termination=game.termination)
        )
    return inserted_id
