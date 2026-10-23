from __future__ import annotations

import contextvars
import hashlib
import hmac
import json
import re
from collections import OrderedDict, defaultdict, deque
from datetime import UTC, datetime, timedelta
from threading import Lock
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.observability_event import ObservabilityEvent


MAX_FRONTEND_EVENTS_PER_REQUEST = 100
MAX_RECENT_BACKEND_ERRORS = 100
MAX_RECENT_FRONTEND_EVENTS = 200
MAX_ROUTE_SNAPSHOT = 50
MAX_RECENT_SLOW_REQUESTS = 100
MAX_RECENT_SLOW_QUERIES = 100
MAX_QUERY_TEMPLATES = 50
MAX_EXTERNAL_CALL_KEYS = 50
ROUTE_SAMPLE_WINDOW = 256
QUERY_SAMPLE_WINDOW = 128
EXTERNAL_SAMPLE_WINDOW = 128
ENGINE_SAMPLE_WINDOW = 128
MINUTE_BUCKETS = 60
LAG_SAMPLES = 30

# Request paths that prove a machine is running, never that a person is here.
# The healthcheck fires every few seconds for the life of the container, and
# the crawler holds the other two open for days on an empty desk.
MACHINE_REQUEST_PREFIXES = (
    "/api/health",
    "/api/games/unanalyzed-fens",
    "/api/analysis/evaluations",
)


_query_count_var: contextvars.ContextVar[list[int] | None] = contextvars.ContextVar(
    "_chessgod_query_count", default=None
)


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _iso(ts: datetime) -> str:
    return ts.isoformat()


def _floor_minute(ts: datetime) -> datetime:
    return ts.replace(second=0, microsecond=0)


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


_QUERY_TEMPLATE_WS_RE = re.compile(r"\s+")
_QUERY_TEMPLATE_LEADING_COMMENT_RE = re.compile(r"^\s*(?:--[^\n]*\n|/\*.*?\*/)\s*", re.DOTALL)


def normalize_query_template(statement: str | None, *, max_len: int = 120) -> str:
    if not statement:
        return "<empty>"
    text = str(statement)
    while True:
        new = _QUERY_TEMPLATE_LEADING_COMMENT_RE.sub("", text, count=1)
        if new == text:
            break
        text = new
    text = _QUERY_TEMPLATE_WS_RE.sub(" ", text).strip()
    if not text:
        return "<empty>"
    if len(text) > max_len:
        text = text[: max_len - 1].rstrip() + "…"
    return text


def _percentiles(samples: list[float]) -> dict[str, float]:
    if not samples:
        return {"p50": 0.0, "p95": 0.0, "p99": 0.0}
    sorted_samples = sorted(samples)

    def pct(p: float) -> float:
        if len(sorted_samples) == 1:
            return sorted_samples[0]
        k = (len(sorted_samples) - 1) * p
        f = int(k)
        c = min(f + 1, len(sorted_samples) - 1)
        if f == c:
            return sorted_samples[f]
        return sorted_samples[f] + (k - f) * (sorted_samples[c] - sorted_samples[f])

    return {
        "p50": round(pct(0.50), 2),
        "p95": round(pct(0.95), 2),
        "p99": round(pct(0.99), 2),
    }


def _status_bucket(status_code: int | None) -> str | None:
    if status_code is None:
        return None
    if 200 <= status_code < 300:
        return "2xx"
    if 300 <= status_code < 400:
        return "3xx"
    if 400 <= status_code < 500:
        return "4xx"
    if 500 <= status_code < 600:
        return "5xx"
    return None


class ObservabilityStore:
    def __init__(self) -> None:
        self._lock = Lock()
        self._started_at = _now_utc()
        self._persist_queue: deque[dict[str, Any]] = deque(maxlen=20000)

        self._backend_total_requests = 0
        # Seeded with the start time rather than None so a restart in the
        # middle of a session keeps warming; an unattended box falls quiet on
        # its own once the window passes with nobody asking for anything.
        self._last_interactive_request_at = self._started_at
        self._backend_routes: dict[str, dict[str, Any]] = {}
        self._backend_recent_errors: deque[dict[str, Any]] = deque(maxlen=MAX_RECENT_BACKEND_ERRORS)
        self._recent_slow_requests: deque[dict[str, Any]] = deque(maxlen=MAX_RECENT_SLOW_REQUESTS)

        self._query_stats: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._recent_slow_queries: deque[dict[str, Any]] = deque(maxlen=MAX_RECENT_SLOW_QUERIES)

        self._external_calls: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._external_state: dict[str, Any] = {}

        self._inflight = 0
        self._max_inflight = 0

        self._minute_buckets: deque[dict[str, Any]] = deque(maxlen=MINUTE_BUCKETS)

        self._background_tasks: dict[str, dict[str, Any]] = {}

        self._engine_metrics: dict[str, Any] = {
            "samples": deque(maxlen=ENGINE_SAMPLE_WINDOW),
            "last_depth": None,
            "last_nps": None,
            "last_queue_depth": None,
            "last_multi_pv": None,
            "last_seen_at": None,
            "errors": 0,
            "completions": 0,
        }

        self._event_loop_lag_ms: float | None = None
        self._event_loop_lag_sampled_at: str | None = None
        self._event_loop_lag_samples: deque[float] = deque(maxlen=LAG_SAMPLES)

        self._process_metrics: dict[str, Any] = {
            "rss_mb": None,
            "cpu_percent": None,
            "sampled_at": None,
        }

        self._pool_stats: dict[str, Any] = {}

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

    # ---- request-scoped query counter ---------------------------------

    @staticmethod
    def begin_request_query_counter() -> contextvars.Token:
        return _query_count_var.set([0])

    @staticmethod
    def end_request_query_counter(token: contextvars.Token) -> int:
        counter = _query_count_var.get()
        count = counter[0] if counter else 0
        _query_count_var.reset(token)
        return count

    @staticmethod
    def increment_request_query_counter() -> None:
        counter = _query_count_var.get()
        if counter is not None:
            counter[0] += 1

    # ---- inflight gauge -----------------------------------------------

    def inflight_increment(self) -> None:
        with self._lock:
            self._inflight += 1
            if self._inflight > self._max_inflight:
                self._max_inflight = self._inflight

    def inflight_decrement(self) -> None:
        with self._lock:
            if self._inflight > 0:
                self._inflight -= 1

    # ---- backend request recording ------------------------------------

    def note_interactive_request(self, path: str) -> None:
        """Record that a *person* asked for something, if this path is one.

        Machine traffic is excluded, because the whole point of the signal is
        to tell an unattended box from one somebody is looking at. The docker
        healthcheck runs every few seconds forever, and the crawler's queue and
        upload endpoints run for days at a stretch with nobody there -- reading
        any of those as presence would mean the warmup never stops, which is
        the state this was written to end.
        """
        if any(path.startswith(prefix) for prefix in MACHINE_REQUEST_PREFIXES):
            return
        with self._lock:
            self._last_interactive_request_at = _now_utc()

    def seconds_since_interactive_request(self) -> float:
        """How long since a person last asked this backend for anything."""
        with self._lock:
            last = self._last_interactive_request_at
        return max(0.0, (_now_utc() - last).total_seconds())

    def record_backend_request(
        self,
        *,
        method: str,
        path: str,
        status_code: int,
        duration_ms: float,
        request_id: str,
        query_count: int = 0,
    ) -> None:
        key = f"{method.upper()} {path}"
        now = _now_utc()
        bucket = _status_bucket(status_code)
        n_plus_one_threshold = settings.observability_n_plus_one_threshold
        slow_threshold = settings.observability_slow_request_ms
        is_high_query = query_count >= n_plus_one_threshold

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
                    "last_query_count": 0,
                    "max_query_count": 0,
                    "high_query_count_total": 0,
                    "_total_duration_ms": 0.0,
                    "_samples": deque(maxlen=ROUTE_SAMPLE_WINDOW),
                    "_status_buckets": defaultdict(int),
                }
                self._backend_routes[key] = route

            route["count"] += 1
            route["_total_duration_ms"] += duration_ms
            route["avg_duration_ms"] = round(route["_total_duration_ms"] / route["count"], 2)
            route["max_duration_ms"] = round(max(route["max_duration_ms"], duration_ms), 2)
            route["last_status_code"] = status_code
            route["last_duration_ms"] = round(duration_ms, 2)
            route["last_seen_at"] = _iso(now)
            route["last_query_count"] = query_count
            if query_count > route["max_query_count"]:
                route["max_query_count"] = query_count
            if is_high_query:
                route["high_query_count_total"] += 1
            route["_samples"].append(duration_ms)
            if bucket is not None:
                route["_status_buckets"][bucket] += 1

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

            if duration_ms >= slow_threshold or is_high_query:
                self._recent_slow_requests.appendleft(
                    {
                        "ts": _iso(now),
                        "request_id": request_id,
                        "method": method.upper(),
                        "path": path,
                        "status_code": status_code,
                        "duration_ms": round(duration_ms, 2),
                        "query_count": query_count,
                        "high_query_count": is_high_query,
                    }
                )

            self._roll_minute_bucket_locked(now, duration_ms, status_code >= 500)

            # A healthy healthcheck is the container asking "are you up?" every
            # few seconds: 72-86% of every stored request row, and nothing
            # anyone reads. It still counts in the live metrics above; only a
            # failing one is worth keeping.
            if path.startswith("/api/health") and status_code < 500 and not path.startswith("/api/health/"):
                return

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

    def _roll_minute_bucket_locked(self, now: datetime, duration_ms: float, is_error: bool) -> None:
        minute = _floor_minute(now)
        if not self._minute_buckets or self._minute_buckets[-1]["minute"] != minute:
            self._minute_buckets.append(
                {
                    "minute": minute,
                    "requests": 0,
                    "errors": 0,
                    "_durations": deque(maxlen=512),
                }
            )
        bucket = self._minute_buckets[-1]
        bucket["requests"] += 1
        if is_error:
            bucket["errors"] += 1
        bucket["_durations"].append(duration_ms)

    # ---- query timing -------------------------------------------------

    def record_query(self, statement: str | None, duration_ms: float) -> None:
        template = normalize_query_template(statement)
        slow_threshold = settings.observability_slow_query_ms
        now = _now_utc()
        with self._lock:
            stats = self._query_stats.get(template)
            if stats is None:
                stats = {
                    "template": template,
                    "count": 0,
                    "total_ms": 0.0,
                    "max_ms": 0.0,
                    "_samples": deque(maxlen=QUERY_SAMPLE_WINDOW),
                    "last_seen_at": None,
                }
                self._query_stats[template] = stats
                if len(self._query_stats) > MAX_QUERY_TEMPLATES:
                    self._query_stats.popitem(last=False)
            else:
                self._query_stats.move_to_end(template)

            stats["count"] += 1
            stats["total_ms"] += duration_ms
            if duration_ms > stats["max_ms"]:
                stats["max_ms"] = duration_ms
            stats["_samples"].append(duration_ms)
            stats["last_seen_at"] = _iso(now)

            if duration_ms >= slow_threshold:
                self._recent_slow_queries.appendleft(
                    {
                        "ts": _iso(now),
                        "template": template,
                        "duration_ms": round(duration_ms, 2),
                    }
                )

    # ---- external call timing ----------------------------------------

    def record_external_call(
        self,
        *,
        service: str,
        operation: str,
        duration_ms: float,
        ok: bool,
        status_code: int | None = None,
    ) -> None:
        key = f"{service} {operation}".strip()
        now = _now_utc()
        with self._lock:
            stats = self._external_calls.get(key)
            if stats is None:
                stats = {
                    "service": service,
                    "operation": operation,
                    "count": 0,
                    "errors": 0,
                    "total_ms": 0.0,
                    "max_ms": 0.0,
                    "_samples": deque(maxlen=EXTERNAL_SAMPLE_WINDOW),
                    "last_seen_at": None,
                    "last_status_code": None,
                }
                self._external_calls[key] = stats
                if len(self._external_calls) > MAX_EXTERNAL_CALL_KEYS:
                    self._external_calls.popitem(last=False)
            else:
                self._external_calls.move_to_end(key)

            stats["count"] += 1
            stats["total_ms"] += duration_ms
            stats["_samples"].append(duration_ms)
            if duration_ms > stats["max_ms"]:
                stats["max_ms"] = duration_ms
            stats["last_seen_at"] = _iso(now)
            stats["last_status_code"] = status_code
            if not ok:
                stats["errors"] += 1

    def update_external_state(self, service: str, state: dict[str, Any] | None) -> None:
        with self._lock:
            if state is None:
                self._external_state.pop(service, None)
            else:
                self._external_state[service] = state

    # ---- background task health --------------------------------------

    def record_background_task(
        self,
        name: str,
        *,
        started_at: datetime,
        finished_at: datetime,
        error: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> None:
        duration_ms = (finished_at - started_at).total_seconds() * 1000.0
        with self._lock:
            entry = self._background_tasks.get(name)
            if entry is None:
                entry = {"name": name, "run_count": 0, "error_count": 0}
                self._background_tasks[name] = entry
            entry["run_count"] += 1
            entry["last_started_at"] = _iso(started_at)
            entry["last_finished_at"] = _iso(finished_at)
            entry["last_duration_ms"] = round(duration_ms, 2)
            entry["last_status"] = "error" if error else "ok"
            entry["last_error"] = error
            entry["last_meta"] = meta
            if error:
                entry["error_count"] += 1
            self._persist_queue.append(
                {
                    "source": "backend",
                    "kind": "background_task",
                    "name": name,
                    "severity": "error" if error else "info",
                    "request_id": None,
                    "method": None,
                    "path": None,
                    "status_code": None,
                    "duration_ms": round(duration_ms, 2),
                    "message": error,
                    "url": None,
                    "meta": _normalize_meta(meta),
                }
            )

    # ---- engine metrics ----------------------------------------------

    def _record_engine_event_locked(
        self,
        *,
        name: str,
        severity: str,
        duration_ms: float | None,
        meta: dict[str, Any] | None,
        ts: datetime,
    ) -> None:
        if name == "engine_error" or severity == "error":
            self._engine_metrics["errors"] += 1
        if duration_ms is not None and duration_ms >= 0:
            self._engine_metrics["samples"].append(duration_ms)
            self._engine_metrics["completions"] += 1
        if meta:
            for key, attr in (
                ("depth", "last_depth"),
                ("nps", "last_nps"),
                ("queue_depth", "last_queue_depth"),
                ("multi_pv", "last_multi_pv"),
            ):
                value = meta.get(key)
                if isinstance(value, (int, float)):
                    self._engine_metrics[attr] = value
        self._engine_metrics["last_seen_at"] = _iso(ts)

    def record_engine_event(
        self,
        *,
        name: str,
        severity: str = "info",
        duration_ms: float | None = None,
        meta: dict[str, Any] | None = None,
        message: str | None = None,
    ) -> None:
        now = _now_utc()
        normalized_meta = _normalize_meta(meta)
        with self._lock:
            self._record_engine_event_locked(
                name=name,
                severity=severity,
                duration_ms=duration_ms,
                meta=normalized_meta,
                ts=now,
            )
            self._persist_queue.append(
                {
                    "source": "backend",
                    "kind": "engine",
                    "name": name,
                    "severity": severity,
                    "request_id": None,
                    "method": None,
                    "path": None,
                    "status_code": None,
                    "duration_ms": round(duration_ms, 2) if duration_ms is not None else None,
                    "message": message,
                    "url": None,
                    "meta": normalized_meta,
                }
            )

    # ---- system samplers ---------------------------------------------

    def update_event_loop_lag(self, sample_ms: float) -> None:
        with self._lock:
            self._event_loop_lag_samples.append(sample_ms)
            if self._event_loop_lag_samples:
                avg = sum(self._event_loop_lag_samples) / len(self._event_loop_lag_samples)
                self._event_loop_lag_ms = round(avg, 3)
                self._event_loop_lag_sampled_at = _iso(_now_utc())

    def update_process_metrics(self, *, rss_mb: float | None, cpu_percent: float | None) -> None:
        with self._lock:
            self._process_metrics = {
                "rss_mb": round(rss_mb, 2) if rss_mb is not None else None,
                "cpu_percent": round(cpu_percent, 2) if cpu_percent is not None else None,
                "sampled_at": _iso(_now_utc()),
            }

    def update_pool_stats(self, stats: dict[str, Any]) -> None:
        with self._lock:
            self._pool_stats = dict(stats)

    # ---- frontend ingest ---------------------------------------------

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
                duration_value: float | None = None
                if isinstance(duration, (int, float)) and duration >= 0:
                    duration_value = round(float(duration), 2)
                    event["duration_ms"] = duration_value

                status_code = raw_event.get("status_code")
                if isinstance(status_code, int):
                    event["status_code"] = status_code

                if request_id is not None:
                    event["request_id"] = request_id

                self._frontend_total_events += 1
                self._frontend_by_kind[kind] += 1
                self._frontend_by_severity[severity] += 1
                self._frontend_recent.appendleft(event)

                if kind == "engine":
                    self._record_engine_event_locked(
                        name=name,
                        severity=severity,
                        duration_ms=duration_value,
                        meta=meta,
                        ts=now,
                    )

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
                        "duration_ms": duration_value,
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

    # ---- snapshot -----------------------------------------------------

    def runtime_snapshot(self) -> dict[str, Any]:
        with self._lock:
            uptime_seconds = int((_now_utc() - self._started_at).total_seconds())

            routes: list[dict[str, Any]] = []
            for route in self._backend_routes.values():
                samples = list(route["_samples"])
                pcts = _percentiles(samples)
                status_buckets = dict(route["_status_buckets"])
                routes.append(
                    {
                        "method": route["method"],
                        "path": route["path"],
                        "count": route["count"],
                        "errors": route["errors"],
                        "avg_duration_ms": route["avg_duration_ms"],
                        "max_duration_ms": route["max_duration_ms"],
                        "p50_duration_ms": pcts["p50"],
                        "p95_duration_ms": pcts["p95"],
                        "p99_duration_ms": pcts["p99"],
                        "last_status_code": route["last_status_code"],
                        "last_duration_ms": route["last_duration_ms"],
                        "last_seen_at": route["last_seen_at"],
                        "last_query_count": route["last_query_count"],
                        "max_query_count": route["max_query_count"],
                        "high_query_count_total": route["high_query_count_total"],
                        "status_buckets": status_buckets,
                    }
                )
            routes.sort(key=lambda item: item["count"], reverse=True)

            queries: list[dict[str, Any]] = []
            for stats in self._query_stats.values():
                samples = list(stats["_samples"])
                pcts = _percentiles(samples)
                count = stats["count"] or 1
                queries.append(
                    {
                        "template": stats["template"],
                        "count": stats["count"],
                        "total_ms": round(stats["total_ms"], 2),
                        "avg_ms": round(stats["total_ms"] / count, 2),
                        "max_ms": round(stats["max_ms"], 2),
                        "p50_ms": pcts["p50"],
                        "p95_ms": pcts["p95"],
                        "p99_ms": pcts["p99"],
                        "last_seen_at": stats["last_seen_at"],
                    }
                )
            queries.sort(key=lambda item: item["total_ms"], reverse=True)

            external: list[dict[str, Any]] = []
            for stats in self._external_calls.values():
                samples = list(stats["_samples"])
                pcts = _percentiles(samples)
                count = stats["count"] or 1
                error_rate = stats["errors"] / count if count else 0.0
                external.append(
                    {
                        "service": stats["service"],
                        "operation": stats["operation"],
                        "count": stats["count"],
                        "errors": stats["errors"],
                        "error_rate": round(error_rate, 4),
                        "avg_ms": round(stats["total_ms"] / count, 2),
                        "max_ms": round(stats["max_ms"], 2),
                        "p50_ms": pcts["p50"],
                        "p95_ms": pcts["p95"],
                        "p99_ms": pcts["p99"],
                        "last_seen_at": stats["last_seen_at"],
                        "last_status_code": stats["last_status_code"],
                    }
                )
            external.sort(key=lambda item: item["count"], reverse=True)

            minute_series: list[dict[str, Any]] = []
            buckets_by_minute = {bucket["minute"]: bucket for bucket in self._minute_buckets}
            now_minute = _floor_minute(_now_utc())
            window_start = now_minute - timedelta(minutes=MINUTE_BUCKETS - 1)
            cursor = window_start
            while cursor <= now_minute:
                bucket = buckets_by_minute.get(cursor)
                if bucket is not None:
                    durations = list(bucket["_durations"])
                    pcts = _percentiles(durations)
                    minute_series.append(
                        {
                            "minute": _iso(cursor),
                            "requests": bucket["requests"],
                            "errors": bucket["errors"],
                            "p95_ms": pcts["p95"],
                        }
                    )
                else:
                    minute_series.append(
                        {"minute": _iso(cursor), "requests": 0, "errors": 0, "p95_ms": 0.0}
                    )
                cursor = cursor + timedelta(minutes=1)

            engine_samples = list(self._engine_metrics["samples"])
            engine_pcts = _percentiles(engine_samples)
            engine_count = len(engine_samples) or 1
            engine_payload = {
                "completions": self._engine_metrics["completions"],
                "errors": self._engine_metrics["errors"],
                "avg_duration_ms": round(sum(engine_samples) / engine_count, 2) if engine_samples else 0.0,
                "p50_duration_ms": engine_pcts["p50"],
                "p95_duration_ms": engine_pcts["p95"],
                "p99_duration_ms": engine_pcts["p99"],
                "last_depth": self._engine_metrics["last_depth"],
                "last_nps": self._engine_metrics["last_nps"],
                "last_queue_depth": self._engine_metrics["last_queue_depth"],
                "last_multi_pv": self._engine_metrics["last_multi_pv"],
                "last_seen_at": self._engine_metrics["last_seen_at"],
            }

            return {
                "uptime_seconds": uptime_seconds,
                "backend": {
                    "total_requests": self._backend_total_requests,
                    "routes": routes[:MAX_ROUTE_SNAPSHOT],
                    "recent_errors": list(self._backend_recent_errors),
                    "slow_requests": list(self._recent_slow_requests),
                    "inflight": self._inflight,
                    "max_inflight": self._max_inflight,
                },
                "queries": {
                    "templates": queries,
                    "slow_recent": list(self._recent_slow_queries),
                },
                "external_calls": {
                    "calls": external,
                    "state": dict(self._external_state),
                },
                "minute_series": minute_series,
                "background_tasks": list(self._background_tasks.values()),
                "engine": engine_payload,
                "system": {
                    "event_loop_lag_ms": self._event_loop_lag_ms,
                    "event_loop_lag_sampled_at": self._event_loop_lag_sampled_at,
                    "process": dict(self._process_metrics),
                    "db_pool": dict(self._pool_stats),
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
            # One statement, not a row at a time through the ORM.
            result = await session.execute(
                delete(ObservabilityEvent).where(ObservabilityEvent.created_at < threshold)
            )
            await session.flush()
            return int(result.rowcount or 0)
        except Exception:
            try:
                await session.rollback()
            except Exception:
                pass
            return 0

    async def persistent_snapshot(
        self,
        session: AsyncSession,
        *,
        events_limit: int = MAX_RECENT_FRONTEND_EVENTS,
        events_offset: int = 0,
    ) -> dict[str, Any]:
        try:
            now = _now_utc()
            five_minutes_ago = now - timedelta(minutes=5)
            one_hour_ago = now - timedelta(hours=1)
            events_limit = max(1, min(events_limit, 500))
            events_offset = max(0, events_offset)

            total_events = await session.scalar(select(func.count()).select_from(ObservabilityEvent))

            recent_stmt = (
                select(ObservabilityEvent)
                .order_by(ObservabilityEvent.created_at.desc(), ObservabilityEvent.id.desc())
                .offset(events_offset)
                .limit(events_limit)
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
                    ObservabilityEvent.duration_ms >= settings.observability_slow_request_ms,
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
            background_events_stmt = (
                select(ObservabilityEvent)
                .where(ObservabilityEvent.kind == "background_task")
                .order_by(ObservabilityEvent.created_at.desc(), ObservabilityEvent.id.desc())
                .limit(1000)
            )
            background_tasks: dict[str, dict[str, Any]] = {}
            for event in (await session.execute(background_events_stmt)).scalars().all():
                task = background_tasks.get(event.name)
                if task is None:
                    task = {
                        "name": event.name,
                        "run_count": 0,
                        "error_count": 0,
                        "last_started_at": None,
                        "last_finished_at": _iso(event.created_at if event.created_at.tzinfo else event.created_at.replace(tzinfo=UTC)),
                        "last_duration_ms": event.duration_ms,
                        "last_status": "error" if event.severity == "error" else "ok",
                        "last_error": event.message,
                        "last_meta": self._safe_load_meta(event.metadata_json),
                    }
                    background_tasks[event.name] = task
                task["run_count"] += 1
                if event.severity == "error":
                    task["error_count"] += 1

            return {
                "total_events": int(total_events or 0),
                "recent_events_limit": events_limit,
                "recent_events_offset": events_offset,
                "events_by_source": source_counts,
                "background_tasks": list(background_tasks.values()),
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
                "recent_events_limit": events_limit,
                "recent_events_offset": events_offset,
                "events_by_source": {},
                "background_tasks": [],
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
