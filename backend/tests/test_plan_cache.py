"""The drill plan is served stale-while-revalidate: fast after every upload,
never stale about the player's own answers."""

from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.routers import improvement as route
from app.schemas.improvement import ImprovementPlanOut
from app.services.improvement import invalidate_improvement_caches


def plan(version: int) -> ImprovementPlanOut:
    return ImprovementPlanOut.model_validate({
        "username": "saint",
        "color": "both",
        "time_class": "rapid_blitz",
        "min_user_rating": 1000,
        "summary": {
            "candidate_positions": version,
            "candidate_positions_is_lower_bound": False,
            "habit_positions": 0,
            "one_off_positions": 0,
            "session_seconds": 0,
            "due_positions": 0,
            "analyzed_decisions": 0,
            "total_decisions": 0,
            "analyzed_by_phase": [],
            "coverage_rate": 0.0,
            "attempts": 0,
            "patterns": [],
            "insights": [],
            "opening_priorities": [],
            "trends": [],
            "retention": {"tracked_positions": 0, "retained_positions": 0, "lapsed_positions": 0},
            "results_by_time_class": [],
            "prescription": {
                "focus": "", "evidence": "", "action": "", "stop": "", "confidence": "low",
            },
        },
        "drills": [],
        "intents": [],
    })


@pytest_asyncio.fixture
async def builds(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    calls: list[int] = []

    async def fake_build(session, **kwargs):
        assert session.bind is engine
        calls.append(len(calls) + 1)
        return plan(len(calls))

    monkeypatch.setattr(route, "build_improvement_plan", fake_build)
    route._plan_refreshes.clear()
    yield calls, sessions
    await engine.dispose()


async def read(sessions) -> int:
    async with sessions() as session:
        served = await route.improvement_plan(
            username="saint", color="both", time_class="rapid_blitz", threshold_cp=80,
            limit=20, min_user_rating=1000, pattern_key=None, session=session,
        )
    return served.summary.candidate_positions


@pytest.mark.asyncio
async def test_a_fresh_plan_is_served_without_rebuilding(builds):
    calls, sessions = builds
    assert await read(sessions) == 1
    assert await read(sessions) == 1
    assert calls == [1]


@pytest.mark.asyncio
async def test_after_an_upload_the_last_plan_is_served_while_it_rebuilds(builds):
    calls, sessions = builds
    assert await read(sessions) == 1
    await invalidate_improvement_caches("saint", include_queue_counts=False)
    # Served at once from the last plan, not after a rebuild.
    assert await read(sessions) == 1
    await asyncio.gather(*route._plan_refreshes.values())
    assert calls == [1, 2]
    # The rebuilt plan is fresh again.
    assert await read(sessions) == 2
    assert calls == [1, 2]


@pytest.mark.asyncio
async def test_many_stale_reads_start_one_rebuild(builds):
    calls, sessions = builds
    await read(sessions)
    await invalidate_improvement_caches("saint", include_queue_counts=False)
    await asyncio.gather(read(sessions), read(sessions), read(sessions))
    await asyncio.gather(*route._plan_refreshes.values())
    assert calls == [1, 2]


@pytest.mark.asyncio
async def test_an_answer_is_never_served_stale(builds):
    calls, sessions = builds
    await read(sessions)
    await route.invalidate_plan("saint")
    # No last plan to fall back on: the next read rebuilds before answering.
    assert await read(sessions) == 2
    assert calls == [1, 2]
