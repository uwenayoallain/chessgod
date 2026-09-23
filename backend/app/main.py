from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime

import httpx
import psutil
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import event
from starlette.requests import Request

from app.config import settings
from app.database import async_session_factory, engine, pool_stats
from app.routers import analysis, games, health, import_games, improvement, theory, tree
from sqlalchemy import select

from app.models.game import Game
from app.routers.theory import family_summaries_bulk
from app.services.cache import get_shared_cache
from app.services.common_book import load_common_book_index
from app.services.mistakes import find_mistakes_cached
from app.routers.improvement import improvement_plan as improvement_plan_route
from app.services.game_scope import DEFAULT_MIN_USER_RATING
from app.services.improvement import DEFAULT_TIME_CLASS
from app.services.opening_families import load_family_tree
from app.services.repertoire import derive_repertoire
from app.services.master_openings import (
    seconds_until_sync_retry,
    seed_opening_book,
    sync_stale_master_data,
)
from app.services.observability import get_observability_store
from app.services.opening_families import seed_opening_families
from app.services.theory import LichessExplorerClient


logger = logging.getLogger(__name__)


async def maintain_master_openings(http_client: httpx.AsyncClient, stop_event: asyncio.Event) -> None:
    store = get_observability_store()
    while not stop_event.is_set():
        started_at = datetime.now(UTC)
        error: str | None = None
        meta: dict[str, int] = {}
        try:
            async with async_session_factory() as session:
                seeded = await seed_opening_book(session)
                seeded_families = await seed_opening_families(session)
                await session.commit()
                refreshed = await sync_stale_master_data(
                    session,
                    LichessExplorerClient(http_client),
                    min_position_games=settings.lichess_sync_min_position_games,
                    max_positions=settings.lichess_sync_max_positions_per_run,
                )
                await session.commit()
                meta = {
                    "seeded_lines": seeded,
                    "seeded_families": seeded_families,
                    "refreshed_positions": refreshed,
                }
                if seeded or seeded_families or refreshed:
                    logger.info("Master opening maintenance complete", extra=meta)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            logger.exception("Master opening maintenance failed")
        finally:
            store.record_background_task(
                "master_openings",
                started_at=started_at,
                finished_at=datetime.now(UTC),
                error=error,
                meta=meta or None,
            )

        # Sleep the normal interval, unless the run just ended in a cooldown --
        # then wake when that expires instead, or the six-hour interval swallows
        # a sixty-second pause and the sync never gets going.
        delay = settings.lichess_sync_interval_hours * 60 * 60
        try:
            async with async_session_factory() as session:
                retry_in = await seconds_until_sync_retry(session)
            if retry_in is not None:
                delay = min(delay, retry_in)
        except Exception:
            logger.exception("Could not read master opening sync cooldown")

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=delay)
        except TimeoutError:
            continue


async def _cache_warmup_worker(stop_event: asyncio.Event) -> None:
    """Keep the expensive response caches hot in the shared cache.

    The heavy read paths (mistakes, repertoire, family stats, coverage) cost
    1-2s cold at millions of rows. Refreshing them here means users only ever
    see cache hits.

    It only does that while somebody is actually here. The claim that "each
    pass is a no-op while the cached entries are fresh" was never true: the
    shortest TTL being warmed is 60s (coverage, family stats) and a pass sleeps
    50s *after* finishing, so at a ~12-15s pass the period is ~65s and those
    entries have always just expired. Every pass recomputed them in full,
    forever, for a browser nobody had open.

    Measured on this box with the crawler stopped and the machine otherwise
    idle: bursts of 0.8-1.6 Postgres cores for 10-15s every ~60s, which alone
    drove the package from 55C to 82C and into thermal throttling. That is
    also 1.0-1.8 cores of "somebody else's work" to the crawler's presence
    guard, so the crawler read its own backend as a person at the keyboard and
    capped itself at one engine around the clock. Warming a cache costs more
    than the cache saves when there is no one to serve it.

    So: no interactive request in `cache_warmup_idle_after_seconds` and the
    pass is skipped. The first person back pays one cold request, once, and
    the warmup picks up from there.
    """
    store = get_observability_store()
    with suppress(TimeoutError):
        await asyncio.wait_for(stop_event.wait(), timeout=15)
    while not stop_event.is_set():
        started_at = datetime.now(UTC)
        error: str | None = None
        warmed = 0
        idle_for = store.seconds_since_interactive_request()
        if idle_for > settings.cache_warmup_idle_after_seconds:
            store.record_background_task(
                "cache_warmup",
                started_at=started_at,
                finished_at=datetime.now(UTC),
                error=None,
                meta={"skipped": "idle", "idle_seconds": round(idle_for)},
            )
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=50)
            except TimeoutError:
                continue
            else:
                break
        try:
            async with async_session_factory() as session:
                usernames = list(
                    (
                        await session.execute(select(Game.username).distinct().limit(5))
                    ).scalars()
                )
                for username in usernames:
                    await find_mistakes_cached(
                        session, username, color="both", min_occurrences=1
                    )
                    # Through the served path: a no-op while the plan is fresh,
                    # one background rebuild when it is stale.
                    await improvement_plan_route(
                        username=username, color="both", time_class=DEFAULT_TIME_CLASS,
                        threshold_cp=80, limit=20, min_user_rating=DEFAULT_MIN_USER_RATING,
                        pattern_key=None, session=session,
                    )
                    for color in ("white", "black"):
                        await derive_repertoire(session, username, color)
                    families = await load_family_tree(session, None)
                    await family_summaries_bulk(
                        session, families, username=username, color="both", time_class=None
                    )
                    # Warm the analysis-coverage counts (min_depth matches the
                    # frontend's request); limit=1 skips most of the fens work.
                    # Not the analysis queue: it walks the whole library (~1.5s)
                    # to warm a progress count the crawler refreshes anyway.
                    warmed += 1
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            logger.debug("Cache warmup failed", exc_info=True)
        store.record_background_task(
            "cache_warmup",
            started_at=started_at,
            finished_at=datetime.now(UTC),
            error=error,
            meta={"usernames": warmed},
        )
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=50)
        except TimeoutError:
            continue


async def _event_loop_lag_sampler(stop_event: asyncio.Event) -> None:
    store = get_observability_store()
    interval = 1.0
    while not stop_event.is_set():
        before = time.perf_counter()
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval)
            return
        except TimeoutError:
            pass
        actual = time.perf_counter() - before
        lag_ms = max(0.0, (actual - interval) * 1000.0)
        store.update_event_loop_lag(lag_ms)


async def _process_metrics_sampler(stop_event: asyncio.Event) -> None:
    store = get_observability_store()
    try:
        proc = psutil.Process()
        proc.cpu_percent(interval=None)
    except Exception:
        logger.exception("Process metrics init failed; sampler disabled")
        return
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=5.0)
            return
        except TimeoutError:
            pass
        try:
            rss_mb = proc.memory_info().rss / (1024 * 1024)
            cpu = proc.cpu_percent(interval=None)
            store.update_process_metrics(rss_mb=rss_mb, cpu_percent=cpu)
        except Exception:
            logger.debug("Process metrics sample failed", exc_info=True)
        try:
            store.update_pool_stats(pool_stats())
        except Exception:
            logger.debug("Pool stats sample failed", exc_info=True)


async def flush_observability_events(*, max_items: int = 1000) -> int:
    store = get_observability_store()
    async with async_session_factory() as session:
        try:
            persisted = await store.persist_queued_events(session, max_items=max_items)
            if persisted:
                await session.commit()
            return persisted
        except Exception:
            await session.rollback()
            logger.debug("Observability event persistence failed", exc_info=True)
            return 0


async def _observability_persistence_worker(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        await flush_observability_events()
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=5.0)
            return
        except TimeoutError:
            continue


def _install_query_listeners() -> None:
    store = get_observability_store()

    def _before(conn, cursor, statement, parameters, context, executemany):  # noqa: ARG001
        context._cg_query_started = time.perf_counter()
        context._cg_query_template = statement

    def _after(conn, cursor, statement, parameters, context, executemany):  # noqa: ARG001
        started = getattr(context, "_cg_query_started", None)
        if started is None:
            return
        duration_ms = (time.perf_counter() - started) * 1000.0
        store.record_query(getattr(context, "_cg_query_template", statement), duration_ms)
        store.increment_request_query_counter()

    sync_engine = engine.sync_engine
    if not getattr(sync_engine, "_chessgod_listeners_installed", False):
        event.listen(sync_engine, "before_cursor_execute", _before)
        event.listen(sync_engine, "after_cursor_execute", _after)
        sync_engine._chessgod_listeners_installed = True  # type: ignore[attr-defined]


@asynccontextmanager
async def lifespan(app: FastAPI):
    _install_query_listeners()

    # Building the common-book index replays every bundled ECO line with
    # python-chess (~6s of CPU). Warm the lru_cache in a thread now instead of
    # blocking the event loop inside the first /api/tree request after boot.
    app.state.book_warmup_task = asyncio.create_task(
        asyncio.to_thread(load_common_book_index)
    )

    app.state.http_client = httpx.AsyncClient(
        headers={"User-Agent": "ChessGod/0.1"},
        timeout=30.0,
        limits=httpx.Limits(max_connections=10),
    )
    app.state.master_openings_stop = asyncio.Event()
    app.state.master_openings_task = asyncio.create_task(
        maintain_master_openings(
            app.state.http_client,
            app.state.master_openings_stop,
        )
    )
    app.state.samplers_stop = asyncio.Event()
    app.state.cache_warmup_task = asyncio.create_task(
        _cache_warmup_worker(app.state.samplers_stop)
    )
    app.state.lag_task = asyncio.create_task(_event_loop_lag_sampler(app.state.samplers_stop))
    app.state.process_task = asyncio.create_task(_process_metrics_sampler(app.state.samplers_stop))
    app.state.observability_persistence_task = asyncio.create_task(
        _observability_persistence_worker(app.state.samplers_stop)
    )
    yield
    app.state.master_openings_stop.set()
    app.state.samplers_stop.set()
    for task in (
        app.state.book_warmup_task,
        app.state.master_openings_task,
        app.state.cache_warmup_task,
        app.state.lag_task,
        app.state.process_task,
        app.state.observability_persistence_task,
    ):
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
    await flush_observability_events(max_items=5000)
    await get_shared_cache().close()
    await app.state.http_client.aclose()
    await engine.dispose()


app = FastAPI(title="ChessGod", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def track_request_metrics(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    request.state.request_id = request_id
    store = get_observability_store()
    store.note_interactive_request(request.url.path)
    counter_token = store.begin_request_query_counter()
    store.inflight_increment()
    started_at = time.perf_counter()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        response.headers["X-Request-ID"] = request_id
        return response
    finally:
        duration_ms = (time.perf_counter() - started_at) * 1000
        query_count = store.end_request_query_counter(counter_token)
        store.inflight_decrement()
        store.record_backend_request(
            method=request.method,
            path=request.url.path,
            status_code=status_code,
            duration_ms=duration_ms,
            request_id=request_id,
            query_count=query_count,
        )

app.include_router(health.router, prefix="/api", tags=["health"])
app.include_router(import_games.router, prefix="/api/import", tags=["import"])
app.include_router(games.router, prefix="/api/games", tags=["games"])
app.include_router(tree.router, prefix="/api/tree", tags=["tree"])
app.include_router(theory.router, prefix="/api/theory", tags=["theory"])
app.include_router(analysis.router, prefix="/api/analysis", tags=["analysis"])
app.include_router(improvement.router, prefix="/api/improvement", tags=["improvement"])
