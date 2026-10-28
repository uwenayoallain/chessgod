from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.config import settings
from app.models.base import Base
from app.models.observability_event import ObservabilityEvent
from app.services.observability import (
    MAX_QUERY_TEMPLATES,
    ObservabilityStore,
    _percentiles,
    normalize_query_template,
)


def _record_request(store: ObservabilityStore, *, path: str, status_code: int, duration_ms: float) -> None:
    store.record_backend_request(
        method="GET",
        path=path,
        status_code=status_code,
        duration_ms=duration_ms,
        request_id=f"req-{path}-{status_code}-{duration_ms}",
    )


def test_percentiles_returns_zero_for_empty() -> None:
    assert _percentiles([]) == {"p50": 0.0, "p95": 0.0, "p99": 0.0}


def test_percentiles_handles_known_distribution() -> None:
    samples = [float(i) for i in range(1, 101)]
    pcts = _percentiles(samples)
    assert pcts["p50"] == pytest.approx(50.5, abs=0.5)
    assert pcts["p95"] == pytest.approx(95.05, abs=0.5)
    assert pcts["p99"] == pytest.approx(99.01, abs=0.5)


def test_normalize_query_template_strips_whitespace_and_truncates() -> None:
    raw = "  SELECT *\nFROM   positions\n   WHERE id = $1  "
    normalized = normalize_query_template(raw)
    assert "  " not in normalized
    assert normalized.startswith("SELECT * FROM positions")


def test_normalize_query_template_strips_leading_comments() -> None:
    raw = "/* slow audit */ SELECT 1"
    assert normalize_query_template(raw) == "SELECT 1"
    raw_dash = "-- audit\nSELECT 2"
    assert normalize_query_template(raw_dash) == "SELECT 2"


def test_normalize_query_template_truncates_long_text() -> None:
    raw = "SELECT " + ", ".join(f"col{i}" for i in range(200))
    assert len(normalize_query_template(raw, max_len=120)) == 120


def test_record_backend_request_tracks_percentiles_and_status_buckets() -> None:
    store = ObservabilityStore()
    for ms in (10.0, 20.0, 30.0, 40.0, 50.0):
        _record_request(store, path="/foo", status_code=200, duration_ms=ms)
    _record_request(store, path="/foo", status_code=404, duration_ms=15.0)
    _record_request(store, path="/foo", status_code=500, duration_ms=60.0)

    snapshot = store.runtime_snapshot()
    routes = {row["path"]: row for row in snapshot["backend"]["routes"]}
    foo = routes["/foo"]

    assert foo["count"] == 7
    assert foo["errors"] == 1
    assert foo["p50_duration_ms"] > 0
    assert foo["p95_duration_ms"] >= foo["p50_duration_ms"]
    assert foo["p99_duration_ms"] >= foo["p95_duration_ms"]
    assert foo["status_buckets"]["2xx"] == 5
    assert foo["status_buckets"]["4xx"] == 1
    assert foo["status_buckets"]["5xx"] == 1


def test_slow_request_log_uses_configured_threshold(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "observability_slow_request_ms", 100, raising=False)
    store = ObservabilityStore()
    _record_request(store, path="/fast", status_code=200, duration_ms=50.0)
    _record_request(store, path="/slow", status_code=200, duration_ms=250.0)

    snapshot = store.runtime_snapshot()
    paths = {row["path"] for row in snapshot["backend"]["slow_requests"]}
    assert "/slow" in paths
    assert "/fast" not in paths


def test_query_count_marks_high_query_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "observability_n_plus_one_threshold", 5, raising=False)
    store = ObservabilityStore()
    store.record_backend_request(
        method="GET",
        path="/n_plus_one",
        status_code=200,
        duration_ms=10.0,
        request_id="rq-1",
        query_count=12,
    )

    snapshot = store.runtime_snapshot()
    routes = {row["path"]: row for row in snapshot["backend"]["routes"]}
    assert routes["/n_plus_one"]["max_query_count"] == 12
    assert routes["/n_plus_one"]["high_query_count_total"] == 1
    slow_rows = snapshot["backend"]["slow_requests"]
    assert any(row["path"] == "/n_plus_one" and row["high_query_count"] for row in slow_rows)


def test_record_query_lru_evicts_oldest_template() -> None:
    store = ObservabilityStore()
    for i in range(MAX_QUERY_TEMPLATES + 5):
        store.record_query(f"SELECT col_{i} FROM t", duration_ms=1.0)

    snapshot = store.runtime_snapshot()
    templates = [row["template"] for row in snapshot["queries"]["templates"]]
    assert len(templates) == MAX_QUERY_TEMPLATES
    assert "SELECT col_0 FROM t" not in templates
    assert any("col_4" in tmpl or f"col_{MAX_QUERY_TEMPLATES + 4}" in tmpl for tmpl in templates)


def test_record_query_promotes_recent_template_on_reuse() -> None:
    store = ObservabilityStore()
    for i in range(MAX_QUERY_TEMPLATES):
        store.record_query(f"SELECT col_{i}", duration_ms=1.0)
    store.record_query("SELECT col_0", duration_ms=2.0)
    for i in range(MAX_QUERY_TEMPLATES, MAX_QUERY_TEMPLATES + 3):
        store.record_query(f"SELECT col_{i}", duration_ms=1.0)

    templates = [row["template"] for row in store.runtime_snapshot()["queries"]["templates"]]
    assert "SELECT col_0" in templates


def test_slow_query_log_uses_configured_threshold(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "observability_slow_query_ms", 50, raising=False)
    store = ObservabilityStore()
    store.record_query("SELECT 1", duration_ms=10.0)
    store.record_query("SELECT 2", duration_ms=200.0)

    snapshot = store.runtime_snapshot()
    slow = [row["template"] for row in snapshot["queries"]["slow_recent"]]
    assert "SELECT 2" in slow
    assert "SELECT 1" not in slow


def test_external_call_aggregates_count_errors_and_percentiles() -> None:
    store = ObservabilityStore()
    for ms in (50.0, 60.0, 70.0):
        store.record_external_call(service="lichess", operation="masters", duration_ms=ms, ok=True, status_code=200)
    store.record_external_call(service="lichess", operation="masters", duration_ms=400.0, ok=False, status_code=429)

    snapshot = store.runtime_snapshot()["external_calls"]["calls"]
    row = next(row for row in snapshot if row["operation"] == "masters")
    assert row["count"] == 4
    assert row["errors"] == 1
    assert row["error_rate"] == pytest.approx(0.25, abs=1e-6)
    assert row["p95_ms"] >= row["p50_ms"]


def test_minute_bucket_rolls_over_per_minute() -> None:
    store = ObservabilityStore()
    now = datetime.now(UTC).replace(second=0, microsecond=0)

    def add_at(minute_offset: int, duration: float, error: bool = False) -> None:
        with store._lock:
            store._roll_minute_bucket_locked(now + timedelta(minutes=minute_offset), duration, error)

    add_at(-2, 10.0)
    add_at(-2, 20.0, error=True)
    add_at(-1, 30.0)
    add_at(0, 40.0)

    series = store.runtime_snapshot()["minute_series"]
    assert len(series) == 60
    last_three = {row["minute"]: row for row in series[-3:]}
    iso = lambda offset: (now + timedelta(minutes=offset)).isoformat()
    assert last_three[iso(-2)]["requests"] == 2
    assert last_three[iso(-2)]["errors"] == 1
    assert last_three[iso(-1)]["requests"] == 1
    assert last_three[iso(0)]["p95_ms"] > 0


def test_minute_series_gap_fills_zero_buckets() -> None:
    store = ObservabilityStore()
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    with store._lock:
        store._roll_minute_bucket_locked(now - timedelta(minutes=10), 50.0, False)

    series = store.runtime_snapshot()["minute_series"]
    assert len(series) == 60
    zero_buckets = [row for row in series if row["requests"] == 0]
    assert len(zero_buckets) == 59


def test_inflight_increments_and_decrements_under_concurrency() -> None:
    store = ObservabilityStore()

    async def driver() -> None:
        async def one() -> None:
            store.inflight_increment()
            await asyncio.sleep(0.01)
            store.inflight_decrement()

        await asyncio.gather(*(one() for _ in range(20)))

    asyncio.run(driver())
    snapshot = store.runtime_snapshot()
    assert snapshot["backend"]["inflight"] == 0
    assert snapshot["backend"]["max_inflight"] >= 1


def test_engine_metrics_populated_from_frontend_event() -> None:
    store = ObservabilityStore()
    store.ingest_frontend_events(
        [
            {
                "kind": "engine",
                "name": "analysis_complete",
                "severity": "info",
                "duration_ms": 1234.5,
                "meta": {"depth": 22, "nps": 1_500_000, "queue_depth": 1, "multi_pv": 3},
            }
        ]
    )
    engine = store.runtime_snapshot()["engine"]
    assert engine["completions"] == 1
    assert engine["last_depth"] == 22
    assert engine["last_nps"] == 1_500_000
    assert engine["last_queue_depth"] == 1
    assert engine["last_multi_pv"] == 3
    assert engine["p95_duration_ms"] > 0


def test_background_task_health_recorded() -> None:
    store = ObservabilityStore()
    started = datetime.now(UTC)
    finished = started + timedelta(seconds=2)
    store.record_background_task("master_openings", started_at=started, finished_at=finished, error=None)
    store.record_background_task("master_openings", started_at=finished, finished_at=finished + timedelta(seconds=1), error="boom")

    tasks = {task["name"]: task for task in store.runtime_snapshot()["background_tasks"]}
    entry = tasks["master_openings"]
    assert entry["run_count"] == 2
    assert entry["error_count"] == 1
    assert entry["last_status"] == "error"
    assert entry["last_error"] == "boom"


def test_event_loop_lag_and_process_metrics_surface_in_snapshot() -> None:
    store = ObservabilityStore()
    for sample in (1.0, 2.0, 3.0):
        store.update_event_loop_lag(sample)
    store.update_process_metrics(rss_mb=128.5, cpu_percent=12.3)
    store.update_pool_stats({"size": 5, "checkedout": 1})

    system = store.runtime_snapshot()["system"]
    assert system["event_loop_lag_ms"] == pytest.approx(2.0, abs=0.001)
    assert isinstance(system["event_loop_lag_sampled_at"], str)
    assert system["process"]["rss_mb"] == 128.5
    assert system["process"]["cpu_percent"] == 12.3
    assert system["db_pool"]["size"] == 5


@pytest.mark.asyncio
async def test_persistent_snapshot_paginates_recent_events() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                ObservabilityEvent(
                    source="backend",
                    kind="request",
                    name=f"event-{idx}",
                    severity="info",
                    created_at=datetime(2026, 4, 26, 12, idx, tzinfo=UTC),
                )
                for idx in range(3)
            ]
        )
        await session.commit()

        snapshot = await ObservabilityStore().persistent_snapshot(
            session,
            events_limit=1,
            events_offset=1,
        )

    await engine.dispose()

    assert snapshot["total_events"] == 3
    assert snapshot["recent_events_limit"] == 1
    assert snapshot["recent_events_offset"] == 1
    assert [event["name"] for event in snapshot["recent_events"]] == ["event-1"]


def test_machine_traffic_never_counts_as_a_person_being_here() -> None:
    """The warmup worker runs off this signal, so what feeds it matters.

    The healthcheck fires every few seconds for the life of the container and
    the crawler holds the queue and upload endpoints open for days. If any of
    them counted as presence the backend would warm its caches forever on an
    empty desk, which is the cost this signal exists to avoid.
    """
    store = ObservabilityStore()
    store._last_interactive_request_at = datetime.now(UTC) - timedelta(hours=2)

    for path in ("/api/health", "/api/games/unanalyzed-fens", "/api/analysis/evaluations"):
        store.note_interactive_request(path)
        assert store.seconds_since_interactive_request() > 3600, path


def test_a_real_request_marks_the_machine_as_attended() -> None:
    store = ObservabilityStore()
    store._last_interactive_request_at = datetime.now(UTC) - timedelta(hours=2)

    store.note_interactive_request("/api/games/saint_uwe/summary")

    assert store.seconds_since_interactive_request() < 5


def test_presence_is_seeded_at_startup_rather_than_left_empty() -> None:
    """A restart mid-session must not leave every cache cold.

    Seeding with the start time gives the backend one idle window to keep
    warming after a restart; an unattended box then falls quiet on its own.
    """
    store = ObservabilityStore()

    assert store.seconds_since_interactive_request() < 5
