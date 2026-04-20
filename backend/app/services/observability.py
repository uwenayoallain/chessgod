from __future__ import annotations

import hashlib
import hmac
import json
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from threading import Lock
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.observability_event import ObservabilityEvent


MAX_FRONTEND_EVENTS_PER_REQUEST = 100
MAX_RECENT_BACKEND_ERRORS = 100
MAX_RECENT_FRONTEND_EVENTS = 200
MAX_ROUTE_SNAPSHOT = 50


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _iso(ts: datetime) -> str:
    return ts.isoformat()


def _normalize_str(value: Any, *, max_len: int) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    return trimmed[:max_len]


def _normalize_meta(value: Any) -> dict[str, str | int | float | bool | None] | None:
    if not isinstance(value, dict):
        return None
    normalized: dict[str, str | int | float | bool | None] = {}
    for raw_key, raw_value in value.items():
        key = _normalize_str(raw_key, max_len=64)
        if key is None:
            continue
        if isinstance(raw_value, (str, int, float, bool)) or raw_value is None:
            normalized[key] = raw_value
        else:
            normalized[key] = _normalize_str(str(raw_value), max_len=256)
    return normalized or None


def _hash_passphrase(passphrase: str) -> str:
    return hashlib.sha256(passphrase.encode("utf-8")).hexdigest()


class ObservabilityStore:
    def __init__(self) -> None:
        self._lock = Lock()
        self._started_at = _now_utc()
        self._persist_queue: deque[dict[str, Any]] = deque(maxlen=20000)

        self._backend_total_requests = 0
        self._backend_routes: dict[str, dict[str, Any]] = {}
        self._backend_recent_errors: deque[dict[str, Any]] = deque(maxlen=MAX_RECENT_BACKEND_ERRORS)

        self._frontend_total_events = 0
        self._frontend_by_kind: dict[str, int] = defaultdict(int)
        self._frontend_by_severity: dict[str, int] = defaultdict(int)
        self._frontend_recent: deque[dict[str, Any]] = deque(maxlen=MAX_RECENT_FRONTEND_EVENTS)

    def verify_admin_passphrase(self, passphrase: str | None) -> bool:
        configured_hash = settings.observability_admin_passphrase_sha256.strip().lower()
        if not configured_hash:
            return False
        if passphrase is None:
            return False
        return hmac.compare_digest(_hash_passphrase(passphrase.strip()), configured_hash)

    def record_backend_request(
        self,
        *,
        method: str,
        path: str,
        status_code: int,
        duration_ms: float,
        request_id: str,
    ) -> None:
        key = f"{method.upper()} {path}"
        now = _now_utc()

        with self._lock:
            self._backend_total_requests += 1

            route = self._backend_routes.get(key)
            if route is None:
                route = {
                    "key": key,
                    "method": method.upper(),
                    "path": path,
                    "count": 0,
                    "errors": 0,
                    "avg_duration_ms": 0.0,
                    "max_duration_ms": 0.0,
                    "last_status_code": None,
                    "last_duration_ms": 0.0,
                    "last_seen_at": None,
                    "_total_duration_ms": 0.0,
                }
                self._backend_routes[key] = route

            route["count"] += 1
            route["_total_duration_ms"] += duration_ms
            route["avg_duration_ms"] = round(route["_total_duration_ms"] / route["count"], 2)
            route["max_duration_ms"] = round(max(route["max_duration_ms"], duration_ms), 2)
            route["last_status_code"] = status_code
            route["last_duration_ms"] = round(duration_ms, 2)
            route["last_seen_at"] = _iso(now)

            if status_code >= 500:
                route["errors"] += 1
                self._backend_recent_errors.appendleft(
                    {
                        "ts": _iso(now),
                        "request_id": request_id,
                        "method": method.upper(),
                        "path": path,
                        "status_code": status_code,
                        "duration_ms": round(duration_ms, 2),
                    }
                )

            self._persist_queue.append(
                {
                    "source": "backend",
                    "kind": "request",
                    "name": "http_request",
                    "severity": "error" if status_code >= 500 else "info",
                    "request_id": request_id,
                    "method": method.upper(),
                    "path": path,
                    "status_code": status_code,
                    "duration_ms": round(duration_ms, 2),
                    "message": None,
                    "url": None,
                    "meta": None,
                }
            )

    def ingest_frontend_events(self, events: list[dict[str, Any]]) -> int:
        accepted = 0
        now = _now_utc()

        with self._lock:
            for raw_event in events[:MAX_FRONTEND_EVENTS_PER_REQUEST]:
                kind = _normalize_str(raw_event.get("kind"), max_len=32)
                name = _normalize_str(raw_event.get("name"), max_len=128)
                severity = _normalize_str(raw_event.get("severity"), max_len=16) or "info"
                request_id = _normalize_str(raw_event.get("request_id"), max_len=128)

                if kind is None or name is None:
                    continue

                event: dict[str, Any] = {
                    "ts": _normalize_str(raw_event.get("created_at"), max_len=64) or _iso(now),
                    "kind": kind,
                    "name": name,
                    "severity": severity,
                }

                message = _normalize_str(raw_event.get("message"), max_len=1000)
                url = _normalize_str(raw_event.get("url"), max_len=2048)
                stack = _normalize_str(raw_event.get("stack"), max_len=4000)
                meta = _normalize_meta(raw_event.get("meta"))

                if message is not None:
                    event["message"] = message
                if url is not None:
                    event["url"] = url
                if stack is not None:
                    event["stack"] = stack
                if meta is not None:
                    event["meta"] = meta

                duration = raw_event.get("duration_ms")
                if isinstance(duration, (int, float)) and duration >= 0:
                    event["duration_ms"] = round(float(duration), 2)

                status_code = raw_event.get("status_code")
                if isinstance(status_code, int):
                    event["status_code"] = status_code

                if request_id is not None:
                    event["request_id"] = request_id

                self._frontend_total_events += 1
                self._frontend_by_kind[kind] += 1
                self._frontend_by_severity[severity] += 1
                self._frontend_recent.appendleft(event)

                self._persist_queue.append(
                    {
                        "source": "frontend",
                        "kind": kind,
                        "name": name,
                        "severity": severity,
                        "request_id": request_id,
                        "method": None,
                        "path": None,
                        "status_code": status_code if isinstance(status_code, int) else None,
                        "duration_ms": round(float(duration), 2) if isinstance(duration, (int, float)) and duration >= 0 else None,
                        "message": message,
                        "url": url,
                        "meta": {
                            "stack": stack,
                            **(meta or {}),
                        }
                        if stack is not None or meta is not None
                        else None,
                    }
                )

                accepted += 1

        return accepted

    def _drain_persist_queue(self, max_items: int = 500) -> list[dict[str, Any]]:
        drained: list[dict[str, Any]] = []
        with self._lock:
            while self._persist_queue and len(drained) < max_items:
                drained.append(self._persist_queue.popleft())
        return drained

    async def persist_queued_events(self, session: AsyncSession, max_items: int = 500) -> int:
        pending = self._drain_persist_queue(max_items=max_items)
        await self.persist_events(session, pending)
        return len(pending)

    def runtime_snapshot(self) -> dict[str, Any]:
        with self._lock:
            uptime_seconds = int((_now_utc() - self._started_at).total_seconds())

            routes = []
            for route in self._backend_routes.values():
                routes.append(
                    {
                        "method": route["method"],
                        "path": route["path"],
                        "count": route["count"],
                        "errors": route["errors"],
                        "avg_duration_ms": route["avg_duration_ms"],
                        "max_duration_ms": route["max_duration_ms"],
                        "last_status_code": route["last_status_code"],
                        "last_duration_ms": route["last_duration_ms"],
                        "last_seen_at": route["last_seen_at"],
                    }
                )
            routes.sort(key=lambda item: item["count"], reverse=True)

            return {
                "uptime_seconds": uptime_seconds,
                "backend": {
                    "total_requests": self._backend_total_requests,
                    "routes": routes[:MAX_ROUTE_SNAPSHOT],
                    "recent_errors": list(self._backend_recent_errors),
                },
                "frontend": {
                    "total_events": self._frontend_total_events,
                    "events_by_kind": dict(self._frontend_by_kind),
                    "events_by_severity": dict(self._frontend_by_severity),
                    "recent_events": list(self._frontend_recent),
                },
            }

    async def persist_events(self, session: AsyncSession, events: list[dict[str, Any]]) -> None:
        if not events:
            return
        try:
            session.add_all(
                [
                    ObservabilityEvent(
                        source=event["source"],
                        kind=event["kind"],
                        name=event["name"],
                        severity=event.get("severity"),
                        request_id=event.get("request_id"),
                        method=event.get("method"),
                        path=event.get("path"),
                        status_code=event.get("status_code"),
                        duration_ms=event.get("duration_ms"),
                        message=event.get("message"),
                        url=event.get("url"),
                        metadata_json=json.dumps(event["meta"]) if event.get("meta") is not None else None,
                    )
                    for event in events
                ]
            )
            await session.flush()
        except Exception:
            with self._lock:
                for event in reversed(events):
                    self._persist_queue.appendleft(event)
            try:
                await session.rollback()
            except Exception:
                pass

    async def purge_expired_events(self, session: AsyncSession) -> int:
        try:
            threshold = _now_utc() - timedelta(days=settings.observability_retention_days)
            stmt = select(ObservabilityEvent).where(ObservabilityEvent.created_at < threshold)
            expired = list((await session.execute(stmt)).scalars().all())
            for item in expired:
                await session.delete(item)
            await session.flush()
            return len(expired)
        except Exception:
            try:
                await session.rollback()
            except Exception:
                pass
            return 0

    async def persistent_snapshot(self, session: AsyncSession) -> dict[str, Any]:
        try:
            now = _now_utc()
            five_minutes_ago = now - timedelta(minutes=5)
            one_hour_ago = now - timedelta(hours=1)

            total_events = await session.scalar(select(func.count()).select_from(ObservabilityEvent))

            recent_stmt = (
                select(ObservabilityEvent)
                .order_by(ObservabilityEvent.created_at.desc(), ObservabilityEvent.id.desc())
                .limit(MAX_RECENT_FRONTEND_EVENTS)
            )
            recent_events = list((await session.execute(recent_stmt)).scalars().all())

            recent_payload = []
            for event in recent_events:
                recent_payload.append(
                    {
                        "id": event.id,
                        "created_at": _iso(event.created_at if event.created_at.tzinfo else event.created_at.replace(tzinfo=UTC)),
                        "source": event.source,
                        "kind": event.kind,
                        "name": event.name,
                        "severity": event.severity,
                        "request_id": event.request_id,
                        "method": event.method,
                        "path": event.path,
                        "status_code": event.status_code,
                        "duration_ms": event.duration_ms,
                        "message": event.message,
                        "url": event.url,
                        "meta": self._safe_load_meta(event.metadata_json),
                    }
                )

            backend_5xx_5m = await session.scalar(
                select(func.count())
                .select_from(ObservabilityEvent)
                .where(
                    ObservabilityEvent.source == "backend",
                    ObservabilityEvent.status_code >= 500,
                    ObservabilityEvent.created_at >= five_minutes_ago,
                )
            )
            frontend_errors_5m = await session.scalar(
                select(func.count())
                .select_from(ObservabilityEvent)
                .where(
                    ObservabilityEvent.source == "frontend",
                    ObservabilityEvent.severity == "error",
                    ObservabilityEvent.created_at >= five_minutes_ago,
                )
            )

            slow_backend_1h = await session.scalar(
                select(func.count())
                .select_from(ObservabilityEvent)
                .where(
                    ObservabilityEvent.source == "backend",
                    ObservabilityEvent.kind == "request",
                    ObservabilityEvent.duration_ms >= 1000,
                    ObservabilityEvent.created_at >= one_hour_ago,
                )
            )

            source_counts_stmt = (
                select(ObservabilityEvent.source, func.count())
                .group_by(ObservabilityEvent.source)
                .order_by(ObservabilityEvent.source.asc())
            )
            source_counts = {
                source: count for source, count in (await session.execute(source_counts_stmt)).all()
            }

            return {
                "total_events": int(total_events or 0),
                "events_by_source": source_counts,
                "alerts": {
                    "backend_5xx_last_5m": int(backend_5xx_5m or 0),
                    "frontend_errors_last_5m": int(frontend_errors_5m or 0),
                    "slow_backend_requests_last_1h": int(slow_backend_1h or 0),
                },
                "recent_events": recent_payload,
            }
        except Exception:
            try:
                await session.rollback()
            except Exception:
                pass
            return {
                "total_events": 0,
                "events_by_source": {},
                "alerts": {
                    "backend_5xx_last_5m": 0,
                    "frontend_errors_last_5m": 0,
                    "slow_backend_requests_last_1h": 0,
                },
                "recent_events": [],
            }

    @staticmethod
    def _safe_load_meta(raw: str | None) -> dict[str, Any] | None:
        if not raw:
            return None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None


_STORE = ObservabilityStore()


def get_observability_store() -> ObservabilityStore:
    return _STORE
