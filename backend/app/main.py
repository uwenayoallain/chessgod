from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from contextlib import suppress

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import async_session_factory
from app.routers import analysis, games, health, import_games, theory, tree
from app.services.master_openings import seed_opening_book, sync_stale_master_data
from app.services.theory import LichessExplorerClient


logger = logging.getLogger(__name__)


async def maintain_master_openings(http_client: httpx.AsyncClient, stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            async with async_session_factory() as session:
                seeded = await seed_opening_book(session)
                await session.commit()
                refreshed = await sync_stale_master_data(
                    session,
                    LichessExplorerClient(http_client),
                )
                await session.commit()
                if seeded or refreshed:
                    logger.info(
                        "Master opening maintenance complete",
                        extra={"seeded_lines": seeded, "refreshed_positions": refreshed},
                    )
        except Exception:
            logger.exception("Master opening maintenance failed")

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=24 * 60 * 60)
        except TimeoutError:
            continue


@asynccontextmanager
async def lifespan(app: FastAPI):
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
    yield
    app.state.master_openings_stop.set()
    app.state.master_openings_task.cancel()
    with suppress(asyncio.CancelledError):
        await app.state.master_openings_task
    await app.state.http_client.aclose()


app = FastAPI(title="ChessGod", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api", tags=["health"])
app.include_router(import_games.router, prefix="/api/import", tags=["import"])
app.include_router(games.router, prefix="/api/games", tags=["games"])
app.include_router(tree.router, prefix="/api/tree", tags=["tree"])
app.include_router(theory.router, prefix="/api/theory", tags=["theory"])
app.include_router(analysis.router, prefix="/api/analysis", tags=["analysis"])
