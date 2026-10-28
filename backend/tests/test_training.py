from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.training import TrainingEvent
from app.services import training
from app.services.training import (
    LEVEL_INTERVALS,
    annotate_repertoire,
    award,
    level_for,
    level_threshold,
    next_level,
    profile,
    record_line_review,
    title_for,
)

NOW = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)

LINE = {
    "id": "scotch",
    "changes": 1,
    "traps": 0,
    "moves": [
        {"side": "opponent", "fen": "start", "uci": "e2e4"},
        {"side": "you", "fen": "after-e4", "uci": "e7e5"},
        {"side": "opponent", "fen": "after-e5", "uci": "g1f3"},
        {"side": "you", "fen": "after-nf3", "uci": "b8c6"},
    ],
}


async def _session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def test_levels_climb_on_a_widening_ladder() -> None:
    assert [level_threshold(level) for level in range(1, 6)] == [0, 100, 300, 600, 1000]
    assert level_for(0) == 1
    assert level_for(99) == 1
    assert level_for(100) == 2
    assert level_for(1000) == 5
    assert title_for(1) == "Pawn"
    assert title_for(5) == "Bishop"
    assert title_for(20) == "King"


def test_a_recalled_move_climbs_one_rung_and_a_miss_starts_over() -> None:
    assert next_level(3, correct=True, due=True) == 4
    assert next_level(8, correct=True, due=True) == 8
    assert next_level(6, correct=False, due=True) == 1
    # Reviewing early proves nothing about memory: no climb.
    assert next_level(3, correct=True, due=False) == 3
    assert next_level(0, correct=True, due=False) == 1


@pytest.mark.asyncio
async def test_learning_a_line_introduces_each_move_and_pays_once() -> None:
    engine, factory = await _session()
    async with factory() as session:
        played = {"after-e4": "e7e5", "after-nf3": "b8c6"}
        first = await record_line_review(
            session, username="tester", color="black", line=LINE, mode="learn",
            played=played, request_id="r1", now=NOW,
        )
        await session.commit()
        again = await record_line_review(
            session, username="tester", color="black", line=LINE, mode="learn",
            played=played, request_id="r2", now=NOW,
        )
        await session.commit()
    assert first["xp_gained"] == training.XP["line_learned"]
    assert again["xp_gained"] == 0
    assert {result["level"] for result in first["results"]} == {1}
    assert first["results"][0]["due_at"] == (NOW + LEVEL_INTERVALS[1]).isoformat()
    await engine.dispose()


@pytest.mark.asyncio
async def test_practice_is_scored_against_the_line_not_the_client() -> None:
    engine, factory = await _session()
    async with factory() as session:
        await record_line_review(
            session, username="tester", color="black", line=LINE, mode="learn",
            played={"after-e4": "e7e5", "after-nf3": "b8c6"}, request_id="learn", now=NOW,
        )
        later = NOW + timedelta(hours=5)
        result = await record_line_review(
            session, username="tester", color="black", line=LINE, mode="practice",
            played={"after-e4": "e7e5", "after-nf3": "g8f6"}, request_id="p1", now=later,
        )
        await session.commit()
    first, second = result["results"]
    assert first["correct"] and first["level"] == 2
    assert not second["correct"] and second["level"] == 1
    assert result["misses"] == 1
    # One recall, one miss, and no perfect-line bonus.
    assert result["xp_gained"] == training.XP["move_recalled"] + training.XP["move_missed"]
    await engine.dispose()


@pytest.mark.asyncio
async def test_a_replayed_request_earns_nothing() -> None:
    engine, factory = await _session()
    async with factory() as session:
        assert await award(session, "tester", "quiz_correct", request_id="q1") == training.XP["quiz_correct"]
        assert await award(session, "tester", "quiz_correct", request_id="q1") == 0
    await engine.dispose()


def _event(kind: str, when: datetime, xp: int | None = None, detail: dict | None = None) -> TrainingEvent:
    return TrainingEvent(
        username="tester", kind=kind, xp=training.XP[kind] if xp is None else xp,
        detail=detail, created_at=when,
    )


@pytest.mark.asyncio
async def test_a_streak_counts_days_the_goal_was_met_and_survives_until_tonight() -> None:
    engine, factory = await _session()
    async with factory() as session:
        for days_ago in (1, 2, 3):
            session.add(_event("game_reviewed", NOW - timedelta(days=days_ago), xp=60))
        session.add(_event("game_reviewed", NOW - timedelta(days=6), xp=60))
        await session.commit()
        before_today = await profile(session, "tester", goal=50, now=NOW)
        session.add(_event("game_reviewed", NOW, xp=60))
        await session.commit()
        after_today = await profile(session, "tester", goal=50, now=NOW)
    # Today not met yet: yesterday's run of three still stands.
    assert before_today["streak"] == 3
    assert not before_today["goal_met_today"]
    assert after_today["streak"] == 4
    assert after_today["best_streak"] == 4
    assert after_today["today_xp"] == 60
    assert [day["xp"] for day in after_today["week"]] == [60, 0, 0, 60, 60, 60, 60]
    unlocked = {a["key"] for a in after_today["achievements"] if a["unlocked_at"]}
    assert "streak_3" in unlocked and "streak_7" not in unlocked
    await engine.dispose()


@pytest.mark.asyncio
async def test_a_missed_day_ends_the_streak() -> None:
    engine, factory = await _session()
    async with factory() as session:
        session.add(_event("game_reviewed", NOW - timedelta(days=2), xp=60))
        await session.commit()
        result = await profile(session, "tester", goal=50, now=NOW)
    assert result["streak"] == 0
    assert result["best_streak"] == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_days_are_the_player_s_own_days() -> None:
    engine, factory = await _session()
    late = datetime(2026, 9, 29, 23, 30, tzinfo=UTC)  # 01:30 on the 30th in Kigali
    async with factory() as session:
        session.add(_event("game_reviewed", late, xp=60))
        await session.commit()
        kigali = await profile(session, "tester", tz="Africa/Kigali", goal=50, now=NOW)
        utc = await profile(session, "tester", tz="UTC", goal=50, now=NOW)
    assert kigali["today_xp"] == 60
    assert utc["today_xp"] == 0
    await engine.dispose()


@pytest.mark.asyncio
async def test_achievements_report_progress_and_unlock_at_their_target() -> None:
    engine, factory = await _session()
    async with factory() as session:
        for minute in range(3):
            session.add(_event("drill_correct", NOW + timedelta(minutes=minute)))
        session.add(_event("line_perfect", NOW, detail={"changes": 1, "traps": 0}))
        await session.commit()
        result = await profile(session, "tester", now=NOW + timedelta(hours=1))
    by_key = {a["key"]: a for a in result["achievements"]}
    assert by_key["first_drill"]["unlocked_at"] is not None
    assert by_key["drills_50"]["progress"] == 3 and by_key["drills_50"]["unlocked_at"] is None
    assert by_key["leak_plugged"]["unlocked_at"] is not None
    assert by_key["trap_setter"]["unlocked_at"] is None
    assert result["xp"] == 3 * training.XP["drill_correct"] + training.XP["line_perfect"]
    await engine.dispose()


def test_a_line_s_status_follows_the_memory_of_its_moves() -> None:
    class Row:
        def __init__(self, level: int, due_at: datetime, recalls: int = 0) -> None:
            self.level = level
            self.due_at = due_at
            self.recalls = recalls

    def annotated(rows: dict) -> dict:
        line = {"id": "x", "moves": [dict(step) for step in LINE["moves"]]}
        return annotate_repertoire({"lines": [line]}, rows, now=NOW)["lines"][0]

    def status(rows: dict) -> str:
        return annotated(rows)["status"]

    later = NOW + timedelta(days=3)
    assert status({}) == "new"
    # Knowing a move this line shares with another does not teach the line.
    assert status({("after-e4", "e7e5"): Row(1, later)}) == "new"
    assert status({("after-e4", "e7e5"): Row(1, later), ("after-nf3", "b8c6"): Row(1, later)}) == "learning"
    assert status({("after-e4", "e7e5"): Row(4, later), ("after-nf3", "b8c6"): Row(2, NOW)}) == "due"
    assert status({("after-e4", "e7e5"): Row(4, later), ("after-nf3", "b8c6"): Row(5, later)}) == "mastered"

    # Learned is not practised: taught with the hint showing, never played from
    # memory. The line is practised once every move has been recalled once.
    taught = annotated({("after-e4", "e7e5"): Row(1, later), ("after-nf3", "b8c6"): Row(1, later)})
    assert taught["status"] == "learning" and taught["practised"] is False
    assert taught["recalled_moves"] == 0
    half = annotated({("after-e4", "e7e5"): Row(1, later, 1), ("after-nf3", "b8c6"): Row(1, later)})
    assert half["practised"] is False and half["recalled_moves"] == 1
    assert [step.get("recalled") for step in half["moves"] if step["side"] == "you"] == [True, False]
    done = annotated({("after-e4", "e7e5"): Row(1, later, 1), ("after-nf3", "b8c6"): Row(2, later, 3)})
    assert done["practised"] is True and done["recalled_moves"] == 2


@pytest.mark.asyncio
async def test_replaying_a_line_before_it_is_due_earns_no_perfect_bonus() -> None:
    engine, factory = await _session()
    played = {"after-e4": "e7e5", "after-nf3": "b8c6"}
    async with factory() as session:
        await record_line_review(session, username="tester", color="black", line=LINE, mode="learn",
                                 played=played, request_id="learn", now=NOW)
        early = await record_line_review(session, username="tester", color="black", line=LINE,
                                         mode="practice", played=played, request_id="p1",
                                         now=NOW + timedelta(minutes=5))
        due = await record_line_review(session, username="tester", color="black", line=LINE,
                                       mode="practice", played=played, request_id="p2",
                                       now=NOW + timedelta(hours=5))
        await session.commit()
    assert early["xp_gained"] == 2 * training.XP["move_early"]
    assert {result["level"] for result in early["results"]} == {1}
    assert due["xp_gained"] == 2 * training.XP["move_recalled"] + training.XP["line_perfect"]
    assert {result["level"] for result in due["results"]} == {2}
    # Both passes were played from memory, so both count as recalls: the early
    # one climbs no rung and pays little, but it still makes the line practised.
    async with factory() as session:
        progress = await training.load_move_progress(session, "tester")
    assert {row.recalls for row in progress.values()} == {2}
    assert {row.reviews for row in progress.values()} == {3}
    await engine.dispose()


from datetime import date  # noqa: E402

from app.services.training import compute_streaks, rival  # noqa: E402

TODAY = date(2026, 9, 30)  # a Wednesday


def _days(*pairs: tuple[int, int]) -> dict:
    return {TODAY - timedelta(days=ago): xp for ago, xp in pairs}


def test_a_freeze_earned_by_xp_carries_a_streak_over_a_missed_day() -> None:
    # 300 XP on day one earns a freeze; day two is missed; the streak survives it.
    streaks = compute_streaks(_days((4, 300), (3, 0), (2, 60), (1, 60)), 50, TODAY)
    assert streaks.current == 3
    assert TODAY - timedelta(days=3) in streaks.frozen
    assert streaks.freezes == 0


def test_without_a_freeze_a_missed_day_ends_the_streak() -> None:
    streaks = compute_streaks(_days((4, 60), (3, 0), (2, 60), (1, 60)), 50, TODAY)
    assert streaks.current == 2
    assert not streaks.frozen


def test_freezes_are_capped_and_today_is_never_spent() -> None:
    streaks = compute_streaks(_days((2, 1000), (1, 60), (0, 10)), 50, TODAY)
    assert streaks.freezes == 2
    assert streaks.current == 2


def test_the_rival_is_last_week_at_the_same_point() -> None:
    days = _days((9, 40), (8, 30), (7, 99), (2, 20), (1, 25), (0, 10))
    # Monday..Wednesday this week against Monday..Wednesday last week.
    assert rival(days, TODAY) == {"this_week": 55, "last_week_so_far": 169, "last_week": 169}


@pytest.mark.asyncio
async def test_a_game_review_pays_only_for_a_game_the_player_owns_once() -> None:
    # Keyed on a hash of the moves on the board, every move played off a
    # reviewed game was a new "game" worth 15 XP. The id has to name a game.
    from fastapi import HTTPException

    from app.models.sparring import SparringGame
    from app.routers.training import reviewed_game_request_id

    _engine, make_session = await _session()
    async with make_session() as session:
        session.add(
            SparringGame(
                username="tester",
                user_color="white",
                engine_rating=1600,
                rated=True,
                result="win",
                reason="checkmate",
                start_fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                moves_uci="e2e4 e7e5",
            )
        )
        await session.commit()
        spar_id = (await session.execute(select(SparringGame.id))).scalar_one()

        key = await reviewed_game_request_id(session, "tester", {"sparring_game_id": spar_id})
        assert key == f"review:spar:{spar_id}"
        # The same key pays once: a second review of the game is a replay.
        assert await training.award(session, "tester", "game_reviewed", request_id=key) == 15
        assert await training.award(session, "tester", "game_reviewed", request_id=key) == 0

        with pytest.raises(HTTPException):
            await reviewed_game_request_id(session, "tester", None)
        with pytest.raises(HTTPException):
            await reviewed_game_request_id(session, "tester", {"game_id": 999_999})
        with pytest.raises(HTTPException):
            # Somebody else's game is not the player's to be paid for.
            await reviewed_game_request_id(session, "someone-else", {"sparring_game_id": spar_id})
