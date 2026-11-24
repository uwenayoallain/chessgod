"""Study Coach and Master Playbook API endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.services.game_scope import player_rating_floor
from app.services.improvement import DEFAULT_TIME_CLASS
from app.services.study_advisor import build_study_guide, serialize_playbook
from app.services.study_curriculum import PLAYBOOKS
from app.services.swr import stale_while_revalidate

router = APIRouter()

_STUDY_FRESH_SECONDS = 900.0
_STUDY_LAST_SECONDS = 86_400.0


@router.get("/guide")
async def get_study_guide(
    username: str = Query(..., min_length=1, max_length=64),
    time_class: str = Query(DEFAULT_TIME_CLASS, pattern="^(rapid_blitz|rapid|blitz)$"),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """Return weakness-matched Master Playbooks, courses, books, and full catalog."""
    min_user_rating = await player_rating_floor(session, username)

    async def compute(db: AsyncSession) -> dict:
        return await build_study_guide(
            db,
            username=username,
            time_class=time_class,
            min_user_rating=min_user_rating,
        )

    key_suffix = f"{username}:{time_class}:{min_user_rating}".lower()
    return await stale_while_revalidate(
        session,
        fresh_base=f"study:guide:{key_suffix}",
        last_key=f"study:guidelast:{key_suffix}",
        compute=compute,
        fresh_ttl=_STUDY_FRESH_SECONDS,
        last_ttl=_STUDY_LAST_SECONDS,
    )


@router.get("/playbooks")
async def list_playbooks() -> dict:
    """Return the complete catalog of built-in Master Playbooks."""
    return {"playbooks": [serialize_playbook(pb) for pb in PLAYBOOKS]}
