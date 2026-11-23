from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
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


@router.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


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
