from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.schemas.observability import (
    FrontendTelemetryIngestRequest,
    FrontendTelemetryIngestResponse,
    ObservabilitySnapshot,
)
from app.services.observability import get_observability_store
from app.services.theory import load_lichess_sync_state

router = APIRouter()
logger = logging.getLogger(__name__)

# How long the readiness probe waits for the database. Under the container
# healthcheck's own 3s client timeout, so a slow database is reported as "not
# ready" by this endpoint rather than as a probe that never answered.
READY_TIMEOUT_SECONDS = 2.0


@router.get("/health")
async def health_check() -> dict[str, str]:
    """Liveness: the process is up and answering. Touches nothing else."""
    return {"status": "ok"}


@router.get("/health/ready")
async def readiness_check(session: AsyncSession = Depends(get_db)) -> dict[str, str]:
    """Readiness: the process can reach its database, within a bounded wait.

    `/health` answers as soon as uvicorn is listening, which says nothing
    about Postgres: with the database gone every real request fails while the
    container still reads as healthy, and the crawler started against it has
    nowhere to fetch work from or store it. One `SELECT 1` answers that. It is
    bounded, because an unreachable database does not refuse a connection so
    much as never answer one, and 503 is the only useful thing to say then.
    """

    try:
        await asyncio.wait_for(session.execute(text("SELECT 1")), timeout=READY_TIMEOUT_SECONDS)
    except Exception as error:  # a timeout, a refused connection, an exhausted pool
        logger.warning("Readiness probe could not reach the database: %s", error or type(error).__name__)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database unavailable",
        ) from error
    return {"status": "ok", "database": "ok"}


def _admin_auth_error() -> HTTPException:
    return HTTPException(status_code=401, detail="Invalid admin passphrase")


def _authorize_admin(passphrase: str | None) -> None:
    if not get_observability_store().verify_admin_passphrase(passphrase):
        raise _admin_auth_error()


@router.get("/health/observability", response_model=ObservabilitySnapshot)
async def health_observability(
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_admin_passphrase: str | None = Header(default=None),
    events_limit: int = Query(default=200, ge=1, le=500),
    events_offset: int = Query(default=0, ge=0),
) -> ObservabilitySnapshot:
    _authorize_admin(x_admin_passphrase)
    store = get_observability_store()
    try:
        await store.persist_queued_events(session, max_items=500)
        await store.purge_expired_events(session)
    except Exception:
        pass
    try:
        lichess_state = await load_lichess_sync_state(session)
        store.update_external_state("lichess", lichess_state)
    except Exception:
        pass
    runtime = store.runtime_snapshot()
    persistent = await store.persistent_snapshot(
        session,
        events_limit=events_limit,
        events_offset=events_offset,
    )
    runtime_background = {item["name"]: item for item in runtime.get("background_tasks", []) if isinstance(item, dict) and "name" in item}
    for item in persistent.get("background_tasks", []):
        if isinstance(item, dict) and "name" in item and item["name"] not in runtime_background:
            runtime_background[item["name"]] = item
    runtime["background_tasks"] = list(runtime_background.values())
    return ObservabilitySnapshot(
        request_id=request.state.request_id,
        generated_at=datetime.now(UTC).isoformat(),
        runtime=runtime,
        persistent=persistent,
    )


@router.post(
    "/health/telemetry",
    response_model=FrontendTelemetryIngestResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def health_telemetry_ingest(
    payload: FrontendTelemetryIngestRequest,
    session: AsyncSession = Depends(get_db),
) -> FrontendTelemetryIngestResponse:
    accepted = get_observability_store().ingest_frontend_events(
        [event.model_dump(exclude_none=True) for event in payload.events]
    )
    try:
        await get_observability_store().persist_queued_events(session, max_items=500)
    except Exception:
        pass
    return FrontendTelemetryIngestResponse(accepted=accepted)
