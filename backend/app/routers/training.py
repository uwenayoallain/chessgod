from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.training import TrainingEvent
from app.services.cache import get_shared_cache
from app.services.game_scope import player_rating_floor
from app.services.improvement import DEFAULT_TIME_CLASS
from app.services.repertoire_builder import build_repertoire
from app.services.swr import stale_while_revalidate
from app.services import (
    challenges,
    clock,
    habits,
    progress,
    rating_goal,
    threats,
    training,
    training_games,
    week_recap,
)

router = APIRouter()

Color = Literal["white", "black"]


def _repertoire_keys(username: str, color: str, time_class: str, floor: int) -> tuple[str, str]:
    suffix = f"{username}:{color}:{time_class}:{floor}"
    # The fresh copy sits under the evidence prefix `invalidate_improvement_caches`
    # drops on every evaluation upload; the last-known copy deliberately does not.
    return f"improvement:repertoire:{suffix}", f"training:repertoirelast:{suffix}"


async def _repertoire(session: AsyncSession, username: str, color: str, time_class: str,
                      *, fresh: bool = False) -> dict:
    floor = await player_rating_floor(session, username)
    fresh_base, last_key = _repertoire_keys(username, color, time_class, floor)

    async def compute(db: AsyncSession) -> dict:
        return await build_repertoire(
            db, username=username, color=color, time_class=time_class, min_user_rating=floor,
        )

    if fresh:
        value = await compute(session)
        cache = get_shared_cache()
        await cache.set_json(await cache.versioned_key(fresh_base), value, ttl_seconds=1_800.0)
        await cache.set_json(last_key.lower(), value, ttl_seconds=86_400.0)
        return value
    return await stale_while_revalidate(
        session, fresh_base=fresh_base, last_key=last_key, compute=compute, fresh_ttl=1_800.0,
    )


@router.get("/repertoire")
async def get_repertoire(
    username: str = Query(..., min_length=1, max_length=64),
    color: Color = Query("black"),
    time_class: str = Query(DEFAULT_TIME_CLASS, pattern="^(rapid_blitz|rapid|blitz)$"),
    # The engine pass reads this after each upload, so it must see its own work.
    fresh: bool = False,
    session: AsyncSession = Depends(get_db),
) -> dict:
    """A repertoire built from the player's games and the engine, with their memory of it."""
    repertoire = await _repertoire(session, username, color, time_class, fresh=fresh)
    progress = await training.load_move_progress(session, username)
    return training.annotate_repertoire(repertoire, progress)


class LineReviewIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    color: Color
    time_class: str = Field(DEFAULT_TIME_CLASS, pattern="^(rapid_blitz|rapid|blitz)$")
    line_id: str = Field(min_length=1, max_length=40)
    mode: Literal["learn", "practice"]
    # The player's first move at each of their positions in the line, by FEN.
    played: dict[str, str] = Field(max_length=64)
    request_id: str | None = Field(default=None, max_length=80)
    tz: str | None = Field(default=None, max_length=64)
    goal: int = training.DEFAULT_DAILY_GOAL


@router.post("/repertoire/review")
async def review_line(payload: LineReviewIn, session: AsyncSession = Depends(get_db)) -> dict:
    repertoire = await _repertoire(session, payload.username, payload.color, payload.time_class)
    line = next((item for item in repertoire["lines"] if item["id"] == payload.line_id), None)
    if line is None:
        raise HTTPException(status_code=409, detail="That line is no longer in your repertoire.")
    before = await training.profile(session, payload.username, tz=payload.tz, goal=payload.goal)
    result = await training.record_line_review(
        session, username=payload.username, color=payload.color, line=line,
        mode=payload.mode, played=payload.played, request_id=payload.request_id,
    )
    await training.settle_quests(session, payload.username, tz=payload.tz)
    await session.commit()
    after = await training.profile(session, payload.username, tz=payload.tz, goal=payload.goal)
    return {**result, **_progress_delta(before, after), "profile": after}


class TrainingEventIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    kind: str
    request_id: str | None = Field(default=None, max_length=80)
    detail: dict | None = None
    tz: str | None = Field(default=None, max_length=64)
    goal: int = training.DEFAULT_DAILY_GOAL


@router.post("/events")
async def record_event(payload: TrainingEventIn, session: AsyncSession = Depends(get_db)) -> dict:
    """Training the server did not see happen: quiz answers and finished game reviews."""
    if payload.kind not in training.CLIENT_EVENTS:
        raise HTTPException(status_code=422, detail="Unknown training event.")
    before = await training.profile(session, payload.username, tz=payload.tz, goal=payload.goal)
    xp = await training.award(
        session, payload.username, payload.kind, detail=payload.detail, request_id=payload.request_id,
    )
    await training.settle_quests(session, payload.username, tz=payload.tz)
    await session.commit()
    after = await training.profile(session, payload.username, tz=payload.tz, goal=payload.goal)
    return {"xp_gained": xp, **_progress_delta(before, after), "profile": after}


@router.get("/profile")
async def get_profile(
    username: str = Query(..., min_length=1, max_length=64),
    tz: str | None = Query(None, max_length=64),
    goal: int = Query(training.DEFAULT_DAILY_GOAL),
    session: AsyncSession = Depends(get_db),
) -> dict:
    # Pays any quest finished by training recorded without the player's day
    # (an older client); a no-op otherwise.
    if await training.settle_quests(session, username, tz=tz):
        await session.commit()
    return await training.profile(session, username, tz=tz, goal=goal, now=datetime.now(UTC))


def _progress_delta(before: dict, after: dict) -> dict:
    """What changed, so the page can celebrate it."""
    unlocked_before = {a["key"] for a in before["achievements"] if a["unlocked_at"]}
    return {
        "leveled_up": after["level"] > before["level"],
        "goal_just_met": after["goal_met_today"] and not before["goal_met_today"],
        "unlocked": [
            a for a in after["achievements"] if a["unlocked_at"] and a["key"] not in unlocked_before
        ],
    }


async def _both_repertoires(session: AsyncSession, username: str) -> list[dict]:
    return [
        await _repertoire(session, username, color, DEFAULT_TIME_CLASS)
        for color in ("black", "white")
    ]


# Three minutes, like Puzzle Rush: long enough to warm up, short enough to replay.
RUSH_SECONDS = 180


@router.get("/rush")
async def rush(
    username: str = Query(..., min_length=1, max_length=64),
    seed: int | None = None,
    session: AsyncSession = Depends(get_db),
) -> dict:
    """A shuffled Opening Rush: every repertoire move once, easiest first."""
    repertoires = await _both_repertoires(session, username)
    return {
        "questions": training_games.rush_questions(repertoires, seed=seed),
        "lives": training_games.RUSH_LIVES,
        "seconds": RUSH_SECONDS,
    }



class RushAnswerIn(BaseModel):
    fen: str = Field(max_length=120)
    played_uci: str = Field(max_length=6)


class RushResultIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    answers: list[RushAnswerIn] = Field(max_length=200)
    request_id: str = Field(min_length=1, max_length=80)
    tz: str | None = Field(default=None, max_length=64)
    goal: int = training.DEFAULT_DAILY_GOAL


@router.post("/rush/result")
async def rush_result(payload: RushResultIn, session: AsyncSession = Depends(get_db)) -> dict:
    """Score a run on the server, pay for it, and send missed moves back to review."""
    repertoires = await _both_repertoires(session, payload.username)
    expected = training_games.expected_moves(repertoires)
    scored = training_games.score_rush(
        [(answer.fen, answer.played_uci) for answer in payload.answers], expected,
    )
    before = await training.profile(session, payload.username, tz=payload.tz, goal=payload.goal)
    xp = min(
        training.RUSH_XP_CAP,
        training.RUSH_XP_BONUS + training.RUSH_XP_PER_ANSWER * scored["score"],
    )
    gained = await training.award(
        session, payload.username, "rush", xp=xp,
        detail={"score": scored["score"], "answered": len(payload.answers)},
        request_id=f"rush:{payload.request_id}",
    )
    requeued = await training_games.requeue(
        session, payload.username,
        [(fen, expected[fen].uci) for fen in scored["missed"] if fen in expected],
    )
    await training.settle_quests(session, payload.username, tz=payload.tz)
    await session.commit()
    after = await training.profile(session, payload.username, tz=payload.tz, goal=payload.goal)
    return {
        "xp_gained": gained,
        "score": scored["score"],
        "best": after["rush_best"],
        "new_best": scored["score"] > before["rush_best"] and gained > 0,
        "requeued": requeued,
        **_progress_delta(before, after),
        "profile": after,
    }


class RepertoireCheckIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)


@router.post("/repertoire/check")
async def check_repertoire(payload: RepertoireCheckIn, session: AsyncSession = Depends(get_db)) -> dict:
    """Where the latest games left the repertoire; learned moves missed there come due now."""
    repertoires = await _both_repertoires(session, payload.username)
    result = await training_games.check_recent_games(session, payload.username, repertoires)
    await session.commit()
    return result



async def _threat_pool(session: AsyncSession, username: str) -> list[dict]:
    floor = await player_rating_floor(session, username)
    suffix = f"{username}:{floor}"

    async def compute(db: AsyncSession) -> list[dict]:
        return await threats.build_pool(db, username=username, min_user_rating=floor)

    return await stale_while_revalidate(
        session,
        fresh_base=f"improvement:threats:{suffix}",
        last_key=f"training:threatslast:{suffix}",
        compute=compute,
        fresh_ttl=1_800.0,
    )


@router.get("/threats")
async def threat_set(
    username: str = Query(..., min_length=1, max_length=64),
    seed: int | None = None,
    session: AsyncSession = Depends(get_db),
) -> dict:
    """Ten of the player's own big mistakes: missed ones that are due first, then new ones."""
    pool = await _threat_pool(session, username)
    answers = (
        await session.execute(
            select(TrainingEvent.kind, TrainingEvent.detail, TrainingEvent.created_at).where(
                TrainingEvent.username == username,
                TrainingEvent.kind.in_(("threat_spotted", "threat_missed")),
            )
        )
    ).all()
    resting, due = threats.schedule(
        [
            (int(detail["position_id"]), kind == "threat_spotted", created_at)
            for kind, detail, created_at in answers
            if detail and "position_id" in detail
        ],
        datetime.now(UTC),
    )
    # The punishment stays on the server until the move is played: the page
    # only learns it from the answer it is scored with.
    questions = [
        {key: value for key, value in item.items() if key not in ("reply_uci", "reply_san")}
        for item in threats.pick_set(pool, exclude=resting, due=due, seed=seed)
    ]
    return {"questions": questions, "pool": len(pool), "due": len(due)}


class ThreatAnswerIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    position_id: int
    played_uci: str = Field(max_length=6)
    request_id: str = Field(min_length=1, max_length=80)
    tz: str | None = Field(default=None, max_length=64)
    goal: int = training.DEFAULT_DAILY_GOAL
    # How many hints were taken before the move (0-2); kept on the event so a
    # find with the piece pointed out is not read as a cold one later.
    hinted: int = Field(default=0, ge=0, le=2)


@router.get("/threats/hint")
async def threat_hint(
    username: str = Query(..., min_length=1, max_length=64),
    position_id: int = Query(...),
    level: int = Query(1, ge=1, le=2),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """A hint toward the punishment: its kind, then the piece. Never the move."""
    pool = await _threat_pool(session, username)
    item = next((entry for entry in pool if entry["position_id"] == position_id), None)
    if item is None:
        raise HTTPException(status_code=409, detail="That position is no longer in your Blunder Check.")
    return threats.hint_for(item["fen"], item["reply_uci"], level)


@router.post("/threats/answer")
async def threat_answer(payload: ThreatAnswerIn, session: AsyncSession = Depends(get_db)) -> dict:
    """Score one answer against the pool, never against what the page says."""
    pool = await _threat_pool(session, payload.username)
    item = next((entry for entry in pool if entry["position_id"] == payload.position_id), None)
    if item is None:
        raise HTTPException(status_code=409, detail="That position is no longer in your Blunder Check.")
    correct = payload.played_uci == item["reply_uci"]
    before = await training.profile(session, payload.username, tz=payload.tz, goal=payload.goal)
    xp = await training.award(
        session, payload.username, "threat_spotted" if correct else "threat_missed",
        detail={"position_id": payload.position_id, "kind": item["kind"], "hinted": payload.hinted},
        request_id=f"threat:{payload.request_id}",
    )
    await training.settle_quests(session, payload.username, tz=payload.tz)
    await session.commit()
    after = await training.profile(session, payload.username, tz=payload.tz, goal=payload.goal)
    return {
        "correct": correct,
        "reply_uci": item["reply_uci"],
        "reply_san": item["reply_san"],
        "better_san": item["better_san"],
        "xp_gained": xp,
        **_progress_delta(before, after),
        "profile": after,
    }



@router.get("/progress")
async def training_progress(
    username: str = Query(..., min_length=1, max_length=64),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """Big mistakes, forcing blunders and opening results over the latest games."""
    floor = await player_rating_floor(session, username)
    suffix = f"{username}:{floor}"

    async def compute(db: AsyncSession) -> dict:
        return await progress.build_progress(db, username=username, min_user_rating=floor)

    return await stale_while_revalidate(
        session,
        fresh_base=f"improvement:progress:{suffix}",
        last_key=f"training:progresslast:{suffix}",
        compute=compute,
        fresh_ttl=1_800.0,
    )


@router.get("/clock")
async def training_clock(
    username: str = Query(..., min_length=1, max_length=64),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """How the player spends their clock, and when their big mistakes happen."""
    floor = await player_rating_floor(session, username)
    suffix = f"{username}:{floor}"

    async def compute(db: AsyncSession) -> dict:
        return await clock.build_clock(db, username=username, min_user_rating=floor)

    return await stale_while_revalidate(
        session,
        fresh_base=f"improvement:clock:{suffix}",
        last_key=f"training:clocklast:{suffix}",
        compute=compute,
        fresh_ttl=1_800.0,
    )


@router.get("/habits")
async def training_habits(
    username: str = Query(..., min_length=1, max_length=64),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """What the player does wrong over the board, and the sitting going on now."""
    floor = await player_rating_floor(session, username)
    suffix = f"{username}:{floor}"

    async def compute(db: AsyncSession) -> dict:
        return await habits.build_habits(db, username=username, min_user_rating=floor)

    report = await stale_while_revalidate(
        session,
        fresh_base=f"improvement:habits:{suffix}",
        last_key=f"training:habitslast:{suffix}",
        compute=compute,
        fresh_ttl=1_800.0,
    )
    # The sitting is read live: it changes while the player is at the board.
    return {**report, "sitting": await habits.current_sitting(session, username=username)}


class ChallengeCheckIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    tz: str | None = Field(default=None, max_length=64)
    goal: int = training.DEFAULT_DAILY_GOAL


@router.post("/challenges/check")
async def check_challenges(payload: ChallengeCheckIn, session: AsyncSession = Depends(get_db)) -> dict:
    """This week's real-game challenges, paying any the imported games have finished."""
    repertoires = await _both_repertoires(session, payload.username)
    before = await training.profile(session, payload.username, tz=payload.tz, goal=payload.goal)
    board, xp, paid = await challenges.settle_challenges(
        session, payload.username, repertoires, tz=payload.tz,
    )
    if not xp:
        return {**board, "xp_gained": 0, "paid": []}
    await training.settle_quests(session, payload.username, tz=payload.tz)
    await session.commit()
    after = await training.profile(session, payload.username, tz=payload.tz, goal=payload.goal)
    return {**board, "xp_gained": xp, "paid": paid, **_progress_delta(before, after), "profile": after}


@router.get("/rating-goal")
async def get_rating_goal(
    username: str = Query(..., min_length=1, max_length=64),
    time_class: Literal["rapid", "blitz"] = Query("rapid"),
    # Omitted: the next hundred at least a hundred points up.
    goal: int | None = Query(None, ge=400, le=3200),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """Where the player's rating is, its pace, and their score against players at the goal."""
    return await rating_goal.build_rating_goal(session, username=username, time_class=time_class, goal=goal)


@router.get("/week")
async def week_scoresheet(
    username: str = Query(..., min_length=1, max_length=64),
    tz: str | None = Query(None, max_length=64),
    weeks_back: int = Query(1, ge=0, le=12),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """A week of real games as a scoresheet: 0 is this week, 1 last week."""
    repertoires = await _both_repertoires(session, username)
    return await week_recap.build_week_recap(
        session, username, repertoires, tz=tz, weeks_back=weeks_back,
    )


async def _punish_pool(session: AsyncSession, username: str) -> list[dict]:
    floor = await player_rating_floor(session, username)
    suffix = f"{username}:{floor}"

    async def compute(db: AsyncSession) -> list[dict]:
        return await threats.build_punish_pool(db, username=username, min_user_rating=floor)

    return await stale_while_revalidate(
        session,
        # Under the threats prefix, so every upload and import that drops
        # Blunder Check's pool drops this one too.
        fresh_base=f"improvement:threats:{suffix}:punish",
        last_key=f"training:punishlast:{suffix}",
        compute=compute,
        fresh_ttl=1_800.0,
    )


@router.get("/punish")
async def punish_set(
    username: str = Query(..., min_length=1, max_length=64),
    seed: int | None = None,
    session: AsyncSession = Depends(get_db),
) -> dict:
    """Ten opponents' mistakes the player handed back: missed ones that are due first."""
    pool = await _punish_pool(session, username)
    answers = (
        await session.execute(
            select(TrainingEvent.kind, TrainingEvent.detail, TrainingEvent.created_at).where(
                TrainingEvent.username == username,
                TrainingEvent.kind.in_(("punish_found", "punish_missed")),
            )
        )
    ).all()
    resting, due = threats.schedule(
        [
            (int(detail["position_id"]), kind == "punish_found", created_at)
            for kind, detail, created_at in answers
            if detail and "position_id" in detail
        ],
        datetime.now(UTC),
    )
    # The answer stays on the server until the move is played.
    questions = [
        {key: value for key, value in item.items() if key not in ("answer_uci", "answer_san")}
        for item in threats.pick_set(pool, exclude=resting, due=due, seed=seed)
    ]
    return {"questions": questions, "pool": len(pool), "due": len(due)}


@router.get("/punish/hint")
async def punish_hint(
    username: str = Query(..., min_length=1, max_length=64),
    position_id: int = Query(...),
    level: int = Query(1, ge=1, le=2),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """A hint toward the move that keeps the gift: its kind, then the piece."""
    pool = await _punish_pool(session, username)
    item = next((entry for entry in pool if entry["position_id"] == position_id), None)
    if item is None:
        raise HTTPException(status_code=409, detail="That position is no longer in Punish it.")
    return threats.hint_for(item["fen"], item["answer_uci"], level)


@router.post("/punish/answer")
async def punish_answer(payload: ThreatAnswerIn, session: AsyncSession = Depends(get_db)) -> dict:
    """Score one Punish it answer against the pool."""
    pool = await _punish_pool(session, payload.username)
    item = next((entry for entry in pool if entry["position_id"] == payload.position_id), None)
    if item is None:
        raise HTTPException(status_code=409, detail="That position is no longer in Punish it.")
    correct = payload.played_uci == item["answer_uci"]
    before = await training.profile(session, payload.username, tz=payload.tz, goal=payload.goal)
    xp = await training.award(
        session, payload.username, "punish_found" if correct else "punish_missed",
        detail={"position_id": payload.position_id, "kind": item["kind"], "hinted": payload.hinted},
        request_id=f"punish:{payload.request_id}",
    )
    await training.settle_quests(session, payload.username, tz=payload.tz)
    await session.commit()
    after = await training.profile(session, payload.username, tz=payload.tz, goal=payload.goal)
    return {
        "correct": correct,
        "answer_uci": item["answer_uci"],
        "answer_san": item["answer_san"],
        "your_move_san": item["your_move_san"],
        "xp_gained": xp,
        **_progress_delta(before, after),
        "profile": after,
    }
