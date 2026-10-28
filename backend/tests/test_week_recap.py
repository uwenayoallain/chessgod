from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.models.training import TrainingEvent
from app.services.week_recap import build_week_recap, notation

NOW = datetime(2026, 10, 1, 12, tzinfo=UTC)


def test_results_are_written_from_whites_side() -> None:
    assert notation("white", "win") == "1–0"
    assert notation("black", "win") == "0–1"
    assert notation("black", "loss") == "1–0"
    assert notation("white", "draw") == "½–½"


@pytest.mark.asyncio
async def test_last_week_is_a_scoresheet_of_its_games() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monday = datetime(2026, 9, 21, 10, tzinfo=UTC)

    def game(game_id: int, when: datetime, color: str, result: str, rating: int, opponent: int) -> Game:
        white = color == "white"
        return Game(
            id=game_id, chesscom_game_url=f"u{game_id}", chesscom_game_id=str(game_id), username="tester",
            white_username="tester" if white else f"o{game_id}", black_username=f"o{game_id}" if white else "tester",
            user_color=color, result="-", user_result=result, time_class="rapid", time_control="600",
            white_rating=rating if white else opponent, black_rating=opponent if white else rating, pgn="-",
            played_at=when, num_moves=40,
        )

    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add_all([
            game(1, monday, "white", "win", 1600, 1650),
            game(2, monday + timedelta(days=2), "black", "loss", 1608, 1590),
            game(3, monday + timedelta(days=4), "black", "win", 1600, 1700),
            # This week: not on last week's sheet.
            game(4, monday + timedelta(days=8), "white", "win", 1610, 1800),
            TrainingEvent(username="tester", kind="quiz_answer", xp=12, created_at=monday + timedelta(days=1)),
        ])
        await session.commit()
        sheet = await build_week_recap(session, "tester", [], now=NOW)
    await engine.dispose()

    assert sheet["week"] == "2026-09-21"
    assert [line["game_id"] for line in sheet["games"]] == [1, 2, 3]
    assert [line["notation"] for line in sheet["games"]] == ["1–0", "1–0", "0–1"]
    assert (sheet["wins"], sheet["draws"], sheet["losses"]) == (2, 0, 1)
    assert sheet["best_win"]["opponent_rating"] == 1700
    assert sheet["ratings"] == {"rapid": {"from": 1600, "to": 1600}}
    assert sheet["xp"] == 12
    # No repertoire given: the book never came up.
    assert sheet["book_games"] == 0
