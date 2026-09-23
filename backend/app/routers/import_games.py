from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette import EventSourceResponse

from app.database import async_session_factory, get_db
from app.models.game import Game
from app.models.import_job import ImportEvent, ImportJob
from app.services.import_jobs import (
    ImportEventPublisher, ImportJobInactive, create_import_job,
    expire_stale_import_jobs, guard_import_commit,
)
from app.schemas.import_progress import ImportSummary
from app.services.chesscom import ChessComClient
from app.services.import_cache import (
    archive_month_from_url,
    get_cached_archive,
    mark_archive_cached,
    should_fetch_archive,
)
from app.services.improvement import invalidate_improvement_caches
from app.services.pgn_parser import parse_game_pgn
from app.services.game_ingest import insert_game
from app.services.cache import get_shared_cache
from app.services.tree_builder import backfill_position_clocks, update_tree_from_game

router = APIRouter()

logger = logging.getLogger(__name__)

# Per-game progress events are throttled: emitting (and React re-rendering) on
# every one of thousands of games adds queue churn and main-thread jank for no
# real UX gain. Archive boundaries always emit; running counts stay accurate
# because archive_complete carries the authoritative totals.
PROGRESS_EVENT_EVERY = 20


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


# played_at uses datetime(1970, 1, 1) as the "unknown date" fallback; anything
# from 1971 on is treated as a real date for the displayed range.
_REAL_DATE_FLOOR = datetime(1971, 1, 1, tzinfo=UTC)


async def build_import_summary(session: AsyncSession, username: str) -> ImportSummary:
    """Summarise a user's imported games with SQL aggregates instead of loading
    every Game row (each carries a large PGN blob) into memory."""
    total_games = await session.scalar(
        select(func.count()).select_from(Game).where(Game.username == username)
    )
    date_from, date_to = (
        await session.execute(
            select(func.min(Game.played_at), func.max(Game.played_at)).where(
                Game.username == username, Game.played_at >= _REAL_DATE_FLOOR
            )
        )
    ).one()
    time_class_rows = await session.execute(
        select(Game.time_class, func.count())
        .where(Game.username == username)
        .group_by(Game.time_class)
    )
    user_rating = case(
        (Game.user_color == "white", Game.white_rating), else_=Game.black_rating
    )
    latest_by_class = (
        select(Game.time_class, func.max(Game.played_at).label("played_at"))
        .where(Game.username == username)
        .group_by(Game.time_class)
        .subquery()
    )
    rating_rows = await session.execute(
        select(Game.time_class, user_rating)
        .join(
            latest_by_class,
            (latest_by_class.c.time_class == Game.time_class)
            & (latest_by_class.c.played_at == Game.played_at),
        )
        .where(Game.username == username, user_rating.is_not(None))
        .order_by(Game.id)
    )
    current_ratings = {tc: int(rating) for tc, rating in rating_rows.all()}
    return ImportSummary(
        username=username,
        total_games=total_games or 0,
        date_range={
            "from": date_from.isoformat() if date_from else None,
            "to": date_to.isoformat() if date_to else None,
        },
        games_by_time_class={tc: count for tc, count in time_class_rows.all()},
        current_ratings=current_ratings,
    )


async def run_import(username: str, request: Request, force: bool = False, *, job_id: str) -> None:
    queue = ImportEventPublisher(job_id)
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

                month_games = list(reversed(await client.fetch_monthly_games(archive_url)))
                new_games = 0
                skipped_games = 0
                clock_rows_backfilled = 0

                async def emit_game_progress(game_index: int, raw_game: dict) -> None:
                    if not (
                        game_index % PROGRESS_EVENT_EVERY == 0
                        or game_index == len(month_games)
                    ):
                        return
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

                for game_index, raw_game in enumerate(month_games, start=1):
                    try:
                        if raw_game.get("rules", "chess") != "chess":
                            raise ValueError("Unsupported chess variant")
                        parsed = parse_game_pgn(raw_game.get("pgn", ""))
                        if parsed.result not in {"1-0", "0-1", "1/2-1/2"}:
                            raise ValueError("Game has no final result")
                        if username.lower() not in {parsed.white_username.lower(), parsed.black_username.lower()}:
                            raise ValueError("Imported player is not a participant")
                    except ValueError as exc:
                        # One malformed/variant game must not discard every
                        # valid game already parsed from this monthly archive.
                        logger.warning("Skipping unsupported game during import: %s", exc)
                        total_skipped += 1
                        skipped_games += 1
                        await emit_game_progress(game_index, raw_game)
                        continue
                    white = raw_game.get("white", {})
                    black = raw_game.get("black", {})
                    user_color = (
                        "white"
                        if parsed.white_username.lower() == username.lower()
                        else "black"
                    )
                    user_result = infer_user_result(user_color, parsed.result)
                    user_side = white if user_color == "white" else black
                    opp_side = black if user_color == "white" else white
                    user_chesscom = user_side.get("result", "")
                    opp_chesscom = opp_side.get("result", "")
                    # For wins use opponent's result (why they lost); for losses/draws use user's
                    termination = (opp_chesscom or None) if user_chesscom == "win" else (user_chesscom or None)
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
                        termination=termination,
                    )
                    inserted_id = await insert_game(session, game)
                    if inserted_id is None:
                        clock_rows_backfilled += await backfill_position_clocks(
                            session, raw_game["url"], parsed, username=username
                        )
                        total_skipped += 1
                        skipped_games += 1
                        await emit_game_progress(game_index, raw_game)
                        continue

                    await update_tree_from_game(
                        session, inserted_id, parsed, parsed.result
                    )
                    # Commit once per archive (below), not per game — per-game
                    # commits were a major chunk of import time.
                    new_games += 1
                    total_new_games += 1
                    await emit_game_progress(game_index, raw_game)

                await mark_archive_cached(
                    session,
                    username=username,
                    archive_url=archive_url,
                    games_in_archive=len(month_games),
                )
                await guard_import_commit(session, job_id)
                await session.commit()
                if new_games or clock_rows_backfilled:
                    await invalidate_improvement_caches(username)
                    await get_shared_cache().delete_prefix(f"repertoire:{username}:")
                    await get_shared_cache().delete_prefix(f"famstats:{username}:")
                    await get_shared_cache().delete_prefix(f"recurrent-opening-pairs:v1:{username}:")
                    await get_shared_cache().delete_prefix(f"opening-recurrence:v1:{username}:")
                else:
                    # A fetched archive can backfill termination metadata on
                    # existing rows even when it inserts no games.
                    await get_shared_cache().delete_prefix(
                        f"improvement:context:{username}:"
                    )
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

        await queue.put(
            {
                "type": "complete",
                "total_new_games": total_new_games,
                "total_skipped": total_skipped,
                "cached_archives": total_cached_archives,
            }
        )
    except ImportJobInactive:
        logger.info("Stopped expired import job %s", job_id)
    except Exception as exc:
        await queue.put({"type": "error", "message": str(exc)})


@router.post("/{username}")
async def start_import(
    username: str,
    background_tasks: BackgroundTasks,
    request: Request,
    force: bool = False,
    session: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    username = username.lower()
    job_id = await create_import_job(session, username)
    if job_id is None:
        raise HTTPException(status_code=409, detail="An import for this player is already running")
    await session.commit()
    background_tasks.add_task(run_import, username, request, force, job_id=job_id)
    return {
        "job_id": job_id,
        "message": "Import started",
        "mode": "force" if force else "cached",
    }


@router.get("/{username}/status")
async def import_status(username: str, request: Request):
    async with async_session_factory() as session:
        job = await session.scalar(select(ImportJob).where(ImportJob.username == username)
                                   .order_by(ImportJob.created_at.desc(), ImportJob.id.desc()).limit(1))
        if job is None:
            raise HTTPException(status_code=404, detail="No import in progress")
        job_id = job.id
    last_event_id = request.headers.get("last-event-id", "")
    prefix = job_id + ":"
    cursor = 0
    if last_event_id.startswith(prefix):
        try:
            cursor = max(0, int(last_event_id[len(prefix):]))
        except ValueError:
            pass

    async def event_generator():
        nonlocal cursor
        while True:
            async with async_session_factory() as session:
                await expire_stale_import_jobs(session, username)
                await session.commit()
                events = list(await session.scalars(select(ImportEvent).where(
                    ImportEvent.job_id == job_id, ImportEvent.id > cursor,
                ).order_by(ImportEvent.id).limit(100)))
                status = await session.scalar(select(ImportJob.status).where(ImportJob.id == job_id))
            for event in events:
                cursor = event.id
                yield {"id": f"{job_id}:{cursor}", "data": json.dumps(event.payload)}
                if event.payload.get("type") in {"complete", "error"}:
                    return
            if not events and status != "running":
                return
            if not events:
                await asyncio.sleep(0.5)

    return EventSourceResponse(event_generator())


@router.get("/{username}/summary", response_model=ImportSummary)
async def import_summary(
    username: str, session: AsyncSession = Depends(get_db)
) -> ImportSummary:
    summary = await build_import_summary(session, username)
    if summary.total_games == 0:
        raise HTTPException(status_code=404, detail="No import summary available")
    return summary
