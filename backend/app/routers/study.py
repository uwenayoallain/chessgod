"""Study Coach, Master Playbooks, and study course endpoints."""

from __future__ import annotations

import base64
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.services import study_courses, study_tts
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


CourseId = Annotated[int, Path(ge=1, le=2**63 - 1)]
CourseUsername = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64, pattern=r"^[^\x00]+$")
]
CourseSession = Annotated[AsyncSession, Depends(get_db)]


class CourseImportIn(BaseModel):
    username: CourseUsername
    title: Annotated[str, StringConstraints(strip_whitespace=True, max_length=300, pattern=r"^[^\x00]*$")] | None = None
    color: Literal["auto", "white", "black"] = "auto"
    lichess_url: str | None = Field(default=None, max_length=256)
    pgn: str | None = Field(default=None, max_length=study_courses.MAX_PGN_BYTES)
    preset_id: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def require_one_source(self) -> CourseImportIn:
        if sum(source is not None for source in (self.lichess_url, self.pgn, self.preset_id)) != 1:
            raise ValueError("Choose exactly one source: a Lichess study, a PGN, or a built-in preset.")
        return self


class CourseMoveReviewIn(BaseModel):
    fen: str = Field(min_length=1, max_length=128)
    expected_uci: str = Field(pattern=r"^[a-h][1-8][a-h][1-8][qrbn]?$")
    played_uci: str = Field(max_length=5)
    hinted: bool


class CourseReviewIn(BaseModel):
    username: CourseUsername
    line_id: str = Field(min_length=1, max_length=40)
    mode: Literal["learn", "practice"]
    moves: list[CourseMoveReviewIn] = Field(max_length=study_courses.MAX_PLIES)
    request_id: str | None = Field(default=None, min_length=1, max_length=80)
    # The player's day and goal, so the lesson's XP counts toward today and the streak.
    tz: str = Field(default="UTC", max_length=64)
    daily_goal: int = Field(default=50, ge=10, le=500)


@router.get("/courses")
async def list_courses(username: CourseUsername, session: CourseSession) -> dict:
    return await study_courses.list_courses(session, username)


@router.post("/courses/import", status_code=201)
async def import_course(payload: CourseImportIn, session: CourseSession) -> dict:
    return await study_courses.import_course(session, **payload.model_dump())


@router.get("/courses/{course_id}")
async def get_course(course_id: CourseId, username: CourseUsername, session: CourseSession) -> dict:
    return await study_courses.get_course(session, username, course_id)


@router.post("/courses/{course_id}/review")
async def review_course_line(course_id: CourseId, payload: CourseReviewIn, session: CourseSession) -> dict:
    return await study_courses.record_course_review(session, course_id=course_id, **payload.model_dump())


@router.delete("/courses/{course_id}")
async def delete_course(course_id: CourseId, username: CourseUsername, session: CourseSession) -> dict:
    return await study_courses.delete_course(session, username, course_id)


TtsVoice = Literal[
    "en-US-AvaMultilingualNeural",
    "en-US-EmmaMultilingualNeural",
    "en-GB-SoniaNeural",
    "en-US-AvaNeural",
    "en-US-JennyNeural",
]
_TTS_CACHE_HEADERS = {"Cache-Control": "public, max-age=86400"}


class StudyTtsIn(BaseModel):
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=study_tts.MAX_TEXT_CHARS)]
    voice: TtsVoice = study_tts.DEFAULT_VOICE
    # Whose point of view the narration takes: where "castles" lands, which rank is "the seventh".
    side: Literal["white", "black"] | None = None


@router.post("/tts")
async def study_tts_audio(payload: StudyTtsIn) -> Response:
    """Read a Playbook or lesson line aloud as MP3, chess notation spoken as words."""
    audio = await study_tts.synthesize_speech(payload.text, payload.voice)
    return Response(content=audio, media_type="audio/mpeg", headers=_TTS_CACHE_HEADERS)


@router.post("/tts/narrate")
async def study_tts_narrate(payload: StudyTtsIn) -> JSONResponse:
    """The same clip as `/tts`, base64 encoded, with board cues timed to the words that name them."""
    narration = await study_tts.narrate(payload.text, payload.voice, payload.side)
    body = {
        "audio_base64": base64.b64encode(narration["audio"]).decode("ascii"),
        "mime_type": "audio/mpeg",
        "voice": narration["voice"],
        "spoken_text": narration["spoken_text"],
        "cues": narration["cues"],
    }
    return JSONResponse(content=body, headers=_TTS_CACHE_HEADERS)
