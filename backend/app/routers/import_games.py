from __future__ import annotations

import asyncio
import json
from collections import Counter
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette import EventSourceResponse

from app.database import async_session_factory, get_db
from app.models.game import Game
from app.schemas.import_progress import ImportSummary
from app.services.chesscom import ChessComClient
from app.services.import_cache import (
    archive_month_from_url,
    get_cached_archive,
    mark_archive_cached,
    should_fetch_archive,
)
from app.services.pgn_parser import parse_game_pgn
from app.services.game_ingest import insert_game
from app.services.tree_builder import update_tree_from_game

router = APIRouter()

import_events: dict[str, asyncio.Queue] = {}
import_summaries: dict[str, ImportSummary] = {}


def parse_played_at(raw_end_time: int | None, fallback: str | None) -> datetime:
    now = datetime.now(UTC)
    if raw_end_time and raw_end_time > 0:
        candidate = datetime.fromtimestamp(raw_end_time, tz=UTC)
        if candidate <= now:
            return candidate
    if fallback:
        try:
            candidate = datetime.strptime(fallback, "%Y.%m.%d").replace(tzinfo=UTC)
            if candidate <= now:
                return candidate
        except ValueError:
            pass
    return datetime(1970, 1, 1, tzinfo=UTC)


def infer_user_result(user_color: str, result: str) -> str:
    if result == "1/2-1/2":
        return "draw"
    if (result == "1-0" and user_color == "white") or (
        result == "0-1" and user_color == "black"
    ):
        return "win"
    return "loss"


def describe_game(raw_game: dict) -> str:
    white_username = raw_game.get("white", {}).get("username", "White")
    black_username = raw_game.get("black", {}).get("username", "Black")
    time_class = raw_game.get("time_class", "game")
    return f"Loading {white_username} vs {black_username} ({time_class})"


async def run_import(username: str, request: Request, force: bool = False) -> None:
    queue = import_events[username]
    client = ChessComClient(request.app.state.http_client)
    total_new_games = 0
    total_skipped = 0
    total_cached_archives = 0

    try:
        archives = list(reversed(await client.fetch_archives(username)))
        async with async_session_factory() as session:
            for index, archive_url in enumerate(archives, start=1):
                archive_label = archive_month_from_url(archive_url)
                await queue.put(
                    {
                        "type": "archive_start",
                        "archive": archive_label,
                        "index": index,
                        "total_archives": len(archives),
                    }
                )

                if not await should_fetch_archive(
                    session, username, archive_url, force=force
                ):
                    cached_archive = await get_cached_archive(
                        session, username, archive_url
                    )
                    total_cached_archives += 1
                    await queue.put(
                        {
                            "type": "archive_complete",
                            "archive": archive_label,
                            "games_in_archive": cached_archive.games_in_archive
                            if cached_archive
                            else 0,
                            "new_games": 0,
                            "skipped_games": cached_archive.games_in_archive
                            if cached_archive
                            else 0,
                            "cached": True,
                        }
                    )
                    continue

                month_games = await client.fetch_monthly_games(archive_url)
                new_games = 0
                skipped_games = 0
                for game_index, raw_game in enumerate(month_games, start=1):
                    existing = await session.scalar(
                        select(Game.id).where(Game.chesscom_game_url == raw_game["url"])
                    )
                    if existing:
                        total_skipped += 1
                        skipped_games += 1
                        await queue.put(
                            {
                                "type": "game_progress",
                                "archive": archive_label,
                                "game_index": game_index,
                                "games_in_archive": len(month_games),
                                "current_game": describe_game(raw_game),
                                "new_games": new_games,
                                "skipped_games": skipped_games,
                            }
                        )
                        continue

                    parsed = parse_game_pgn(raw_game["pgn"])
                    white = raw_game.get("white", {})
                    black = raw_game.get("black", {})
                    user_color = (
                        "white"
                        if white.get("username", "").lower() == username.lower()
                        else "black"
                    )
                    user_result = infer_user_result(user_color, parsed.result)
                    game = Game(
                        chesscom_game_url=raw_game["url"],
                        chesscom_game_id=raw_game["url"].rstrip("/").split("/")[-1],
                        username=username,
                        white_username=parsed.white_username,
                        black_username=parsed.black_username,
                        user_color=user_color,
                        result=parsed.result,
                        user_result=user_result,
                        time_class=raw_game.get(
                            "time_class", parsed.time_class or "unknown"
                        ),
                        time_control=raw_game.get("time_control", parsed.time_control),
                        white_rating=white.get("rating", parsed.white_rating),
                        black_rating=black.get("rating", parsed.black_rating),
                        pgn=raw_game["pgn"],
                        eco=parsed.eco,
                        opening_name=parsed.opening_name,
                        played_at=parse_played_at(
                            raw_game.get("end_time"), parsed.played_at
                        ),
                        num_moves=parsed.num_moves,
                    )
                    inserted_id = await insert_game(session, game)
                    if inserted_id is None:
                        total_skipped += 1
                        skipped_games += 1
                        await queue.put(
                            {
                                "type": "game_progress",
                                "archive": archive_label,
                                "game_index": game_index,
                                "games_in_archive": len(month_games),
                                "current_game": describe_game(raw_game),
                                "new_games": new_games,
                                "skipped_games": skipped_games,
                            }
                        )
                        continue

                    await update_tree_from_game(
                        session, inserted_id, parsed, parsed.result
                    )
                    await session.commit()
                    new_games += 1
                    total_new_games += 1
                    await queue.put(
                        {
                            "type": "game_progress",
                            "archive": archive_label,
                            "game_index": game_index,
                            "games_in_archive": len(month_games),
                            "current_game": describe_game(raw_game),
                            "new_games": new_games,
                            "skipped_games": skipped_games,
                        }
                    )

                await mark_archive_cached(
                    session,
                    username=username,
                    archive_url=archive_url,
                    games_in_archive=len(month_games),
                )
                await session.commit()
                await queue.put(
                    {
                        "type": "archive_complete",
                        "archive": archive_label,
                        "games_in_archive": len(month_games),
                        "new_games": new_games,
                        "skipped_games": skipped_games,
                        "cached": False,
                    }
                )

            totals = await session.execute(
                select(Game).where(Game.username == username)
            )
            imported_games = list(totals.scalars().all())
            date_values = (
                sorted(
                    game.played_at.isoformat()
                    for game in imported_games
                    if game.played_at.year > 1970
                )
                if imported_games
                else []
            )
            import_summaries[username] = ImportSummary(
                username=username,
                total_games=len(imported_games),
                date_range={
                    "from": date_values[0] if date_values else None,
                    "to": date_values[-1] if date_values else None,
                },
                games_by_time_class=dict(
                    Counter(game.time_class for game in imported_games)
                ),
            )

        await queue.put(
            {
                "type": "complete",
                "total_new_games": total_new_games,
                "total_skipped": total_skipped,
                "cached_archives": total_cached_archives,
            }
        )
    except Exception as exc:
        await queue.put({"type": "error", "message": str(exc)})


@router.post("/{username}")
async def start_import(
    username: str,
    background_tasks: BackgroundTasks,
    request: Request,
    force: bool = False,
) -> dict[str, str]:
    import_events[username] = asyncio.Queue()
    background_tasks.add_task(run_import, username, request, force)
    return {
        "job_id": str(uuid4()),
        "message": "Import started",
        "mode": "force" if force else "cached",
    }


@router.get("/{username}/status")
async def import_status(username: str):
    queue = import_events.get(username)
    if queue is None:
        raise HTTPException(status_code=404, detail="No import in progress")

    async def event_generator():
        while True:
            event = await queue.get()
            yield {"data": json.dumps(event)}
            if event.get("type") in {"complete", "error"}:
                break

    return EventSourceResponse(event_generator())


@router.get("/{username}/summary", response_model=ImportSummary)
async def import_summary(
    username: str, session: AsyncSession = Depends(get_db)
) -> ImportSummary:
    if username in import_summaries:
        return import_summaries[username]

    result = await session.execute(select(Game).where(Game.username == username))
    games = list(result.scalars().all())
    if not games:
        raise HTTPException(status_code=404, detail="No import summary available")

    date_values = sorted(
        game.played_at.isoformat() for game in games if game.played_at.year > 1970
    )
    return ImportSummary(
        username=username,
        total_games=len(games),
        date_range={"from": date_values[0], "to": date_values[-1]},
        games_by_time_class=dict(Counter(game.time_class for game in games)),
    )
