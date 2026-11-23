from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session_factory, get_db
from app.services.cache import get_shared_cache
from app.schemas.improvement import (
    DrillAttemptIn,
    DrillAttemptOut,
    ImprovementPlanOut,
    PointsLostOut,
)
from app.services.game_scope import player_rating_floor
from app.services.improvement import DEFAULT_TIME_CLASS, build_improvement_plan, record_drill_attempt
from app.services.points_lost import build_points_lost
from app.services.swr import stale_while_revalidate
from app.services import training


router = APIRouter()
logger = logging.getLogger(__name__)

# The plan is served stale-while-revalidate. Every evaluation upload bumps the
# player's generation (the crawler uploads about every forty seconds), so a plain
# cache was almost always cold and opening Review cost a full rebuild (~1.6s).
# The fresh entry follows that generation; the last-known one is served at once
# while a single background rebuild catches up. Drill answers drop both, so the
# player's own progress is never shown stale.
_PLAN_FRESH_SECONDS = 1_800.0
_PLAN_LAST_SECONDS = 86_400.0
_plan_refreshes: dict[str, asyncio.Task] = {}


def _plan_keys(username: str, params: dict) -> tuple[str, str]:
    suffix = ":".join(str(params[name]) for name in sorted(params))
    return (
        f"improvement:plan:{username}:{suffix}".lower(),
        f"improvement:planlast:{username}:{suffix}".lower(),
    )


async def _build_and_store(session: AsyncSession, username: str, params: dict) -> ImprovementPlanOut:
    cache = get_shared_cache()
    fresh_base, last_key = _plan_keys(username, params)
    # Capture the generation before reading, so a result computed across an
    # upload is filed under the generation it actually saw.
    fresh_key = await cache.versioned_key(fresh_base)
    plan = await build_improvement_plan(session, username=username, **params)
    payload = plan.model_dump(mode="json")
    await cache.set_json(fresh_key, payload, ttl_seconds=_PLAN_FRESH_SECONDS)
    await cache.set_json(last_key, payload, ttl_seconds=_PLAN_LAST_SECONDS)
    return plan


def _refresh_in_background(username: str, params: dict) -> None:
    _, last_key = _plan_keys(username, params)
    running = _plan_refreshes.get(last_key)
    if running is not None and not running.done():
        return

    async def refresh() -> None:
        try:
            async with async_session_factory() as session:
                await _build_and_store(session, username, params)
        except Exception:
            logger.warning("Background plan refresh failed for %s", username, exc_info=True)

    _plan_refreshes[last_key] = asyncio.create_task(refresh())


async def invalidate_plan(username: str) -> None:
    cache = get_shared_cache()
    await cache.delete_prefix(f"improvement:plan:{username}:", versioned_only=True)
    await cache.delete_prefix(f"improvement:planlast:{username}:")


@router.get("/plan", response_model=ImprovementPlanOut)
async def improvement_plan(
    username: str = Query(...),
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str = Query(DEFAULT_TIME_CLASS, pattern="^(rapid_blitz|rapid|blitz)$"),
    threshold_cp: int = Query(80, ge=50, le=500),
    limit: int = Query(20, ge=1, le=50),
    # Omitted, it follows the player (`player_rating_floor`).
    min_user_rating: int | None = Query(None, ge=100, le=4000),
    pattern_key: str | None = Query(None, min_length=1, max_length=64),
    session: AsyncSession = Depends(get_db),
) -> ImprovementPlanOut:
    if min_user_rating is None:
        min_user_rating = await player_rating_floor(session, username)
    params = {
        "color": color,
        "time_class": time_class,
        "threshold_cp": threshold_cp,
        "limit": limit,
        "min_user_rating": min_user_rating,
        "pattern_key": pattern_key,
    }
    cache = get_shared_cache()
    fresh_base, last_key = _plan_keys(username, params)
    fresh = await cache.get_json(await cache.versioned_key(fresh_base))
    if fresh is not None:
        return ImprovementPlanOut.model_validate(fresh)
    last = await cache.get_json(last_key)
    if last is not None:
        _refresh_in_background(username, params)
        return ImprovementPlanOut.model_validate(last)
    return await _build_and_store(session, username, params)


@router.get("/where-points-go", response_model=PointsLostOut)
async def where_points_go(
    username: str = Query(..., min_length=1, max_length=64),
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str = Query(DEFAULT_TIME_CLASS, pattern="^(rapid_blitz|rapid|blitz)$"),
    session: AsyncSession = Depends(get_db),
) -> PointsLostOut:
    """Which phase and which kind of move the player's winning chances go to."""
    min_user_rating = await player_rating_floor(session, username)
    # v2: adds how each colour comes out of the opening.
    suffix = f"{username}:v2:{color}:{time_class}:{min_user_rating}"

    async def compute(db: AsyncSession) -> dict:
        result = await build_points_lost(
            db, username=username, color=color, time_class=time_class,
            min_user_rating=min_user_rating,
        )
        return result.model_dump(mode="json")

    # ~1s over a 90k-decision library, and it moves only as evidence arrives:
    # the fresh copy follows the evidence generation (`invalidate_improvement_caches`),
    # the last-known one sits outside that prefix so a stale read is instant.
    payload = await stale_while_revalidate(
        session,
        fresh_base=f"improvement:losses:{suffix}",
        last_key=f"improvement:losseslast:{suffix}",
        compute=compute,
        fresh_ttl=1_800.0,
    )
    return PointsLostOut.model_validate(payload)


@router.post("/attempts", response_model=DrillAttemptOut)
async def improvement_attempt(
    payload: DrillAttemptIn,
    session: AsyncSession = Depends(get_db),
) -> DrillAttemptOut:
    try:
        result = await record_drill_attempt(session, payload)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    solved = result.correct and result.follow_up_correct is not False
    result.xp_gained = await training.award(
        session, payload.username, "drill_correct" if solved else "drill_wrong",
        detail={"position_id": payload.position_id, "pattern": payload.pattern_key},
        request_id=f"drill:{payload.request_id}" if payload.request_id else None,
    )
    await training.settle_quests(session, payload.username, tz=payload.tz)
    await session.commit()
    # Progress is part of the plan: an answer must show on the next read.
    await invalidate_plan(payload.username)
    return result
