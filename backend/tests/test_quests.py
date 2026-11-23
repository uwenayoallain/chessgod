from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.training import TrainingEvent
from app.services import quests, training

DAY = date(2026, 9, 30)


def test_the_days_quests_are_fixed_and_the_third_rotates() -> None:
    first = quests.daily_quests("tester", DAY)
    assert first == quests.daily_quests("TESTER", DAY)
    assert first[:2] == (quests.THREATS, quests.OPENING)
    week = {quests.daily_quests("tester", DAY + timedelta(days=offset))[2].key for offset in range(4)}
    assert week == {quest.key for quest in quests.ROTATION}


def test_progress_counts_the_days_training_and_never_its_own_rewards() -> None:
    events = [
        ("threat_spotted", {}), ("threat_missed", {}), ("threat_spotted", {}), ("threat_spotted", {}),
        # Opening moves: recalled, early, a learned line's moves, a Rush score.
        ("move_recalled", {}), ("move_early", {}), ("line_learned", {"moves": 3}), ("rush", {"score": 4}),
        ("quest_done", {"quest": "threats"}),
    ]
    board = quests.quest_board("tester", DAY, events)
    threats, opening, _ = board["items"]
    assert (threats["progress"], threats["done"], threats["claimed"]) == (3, True, True)
    assert (opening["progress"], opening["done"], opening["claimed"]) == (9, False, False)
    assert not board["all_done"]
    assert not board["chest_opened"]


@pytest.mark.asyncio
async def test_finished_quests_and_the_chest_are_paid_once() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    today = datetime.now(UTC).date()
    third = quests.daily_quests("tester", today)[2]
    third_kind = {"drills": "drill_correct", "review": "game_reviewed", "quiz": "quiz_correct",
                  "sparring": "sparring_game"}[third.key]

    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        for index in range(3):
            await training.award(session, "tester", "threat_spotted", request_id=f"t{index}")
        # Spotted yesterday: not today's quest.
        session.add(TrainingEvent(username="tester", kind="threat_spotted", xp=5,
                                  created_at=datetime.now(UTC) - timedelta(days=1)))
        assert await training.settle_quests(session, "tester") == quests.QUEST_XP
        assert await training.settle_quests(session, "tester") == 0

        await training.award(session, "tester", "rush", xp=25, detail={"score": 10}, request_id="r")
        for index in range(third.target):
            await training.award(session, "tester", third_kind, request_id=f"x{index}")
        # Both remaining quests, then the chest for all three.
        assert await training.settle_quests(session, "tester") == 2 * quests.QUEST_XP + quests.CHEST_XP
        assert await training.settle_quests(session, "tester") == 0
        await session.commit()

        shown = await training.profile(session, "tester")
        kinds = (await session.execute(select(TrainingEvent.kind))).scalars().all()
    await engine.dispose()

    assert kinds.count("quest_done") == 3
    assert kinds.count("quests_all") == 1
    board = shown["quests"]
    assert board["all_done"] and board["chest_opened"]
    assert all(item["claimed"] for item in board["items"])
    master = next(a for a in shown["achievements"] if a["key"] == "quest_master")
    assert master["progress"] == 1
