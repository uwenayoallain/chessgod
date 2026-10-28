from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.services.game_scope import DEFAULT_MIN_USER_RATING, player_rating_floor


def _game(game_id: int, *, time_class: str, rating: int | None, played_at: datetime,
          user_color: str = "white") -> Game:
    return Game(
        id=game_id,
        chesscom_game_url=f"https://chess.com/game/{game_id}",
        chesscom_game_id=str(game_id),
        username="tester",
        white_username="tester" if user_color == "white" else "opponent",
        black_username="opponent" if user_color == "white" else "tester",
        user_color=user_color,
        result="1-0",
        user_result="win" if user_color == "white" else "loss",
        time_class=time_class,
        time_control="600",
        white_rating=rating if user_color == "white" else 1500,
        black_rating=rating if user_color == "black" else 1500,
        pgn="1. e4 e5 1-0",
        played_at=played_at,
        num_moves=2,
    )


async def _floor(games: list[Game]) -> int:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add_all(games)
        await session.commit()
        floor = await player_rating_floor(session, "tester")
    await engine.dispose()
    return floor


@pytest.mark.asyncio
async def test_a_player_below_the_default_keeps_their_own_games() -> None:
    # A fixed 1,000 left an 800 player with no games to analyse or drill at all.
    floor = await _floor([
        _game(1, time_class="rapid", rating=700, played_at=datetime(2025, 1, 1, tzinfo=UTC)),
        _game(2, time_class="rapid", rating=820, played_at=datetime(2025, 6, 1, tzinfo=UTC)),
    ])
    assert floor == 620


@pytest.mark.asyncio
async def test_a_player_past_the_default_keeps_the_default() -> None:
    # Their early games stay out, exactly as before.
    floor = await _floor([
        _game(1, time_class="rapid", rating=1669, played_at=datetime(2025, 6, 1, tzinfo=UTC)),
        _game(2, time_class="blitz", rating=1422, played_at=datetime(2025, 6, 2, tzinfo=UTC)),
    ])
    assert floor == DEFAULT_MIN_USER_RATING


@pytest.mark.asyncio
async def test_the_weaker_time_control_sets_the_floor() -> None:
    # Rapid alone would put the floor at 1,000 and filter out every blitz game.
    floor = await _floor([
        _game(1, time_class="rapid", rating=1300, played_at=datetime(2025, 6, 1, tzinfo=UTC)),
        _game(2, time_class="blitz", rating=900, played_at=datetime(2025, 6, 2, tzinfo=UTC),
              user_color="black"),
    ])
    assert floor == 700


@pytest.mark.asyncio
async def test_the_latest_rating_counts_not_the_peak() -> None:
    floor = await _floor([
        _game(1, time_class="rapid", rating=1400, played_at=datetime(2025, 1, 1, tzinfo=UTC)),
        _game(2, time_class="rapid", rating=950, played_at=datetime(2025, 6, 1, tzinfo=UTC)),
    ])
    assert floor == 750


@pytest.mark.asyncio
async def test_unrated_and_empty_libraries_keep_the_default() -> None:
    assert await _floor([]) == DEFAULT_MIN_USER_RATING
    assert await _floor([
        _game(1, time_class="daily", rating=600, played_at=datetime(2025, 1, 1, tzinfo=UTC)),
        _game(2, time_class="rapid", rating=None, played_at=datetime(2025, 1, 1, tzinfo=UTC)),
    ]) == DEFAULT_MIN_USER_RATING


@pytest.mark.asyncio
async def test_the_floor_never_drops_below_the_lowest_bound() -> None:
    floor = await _floor([
        _game(1, time_class="rapid", rating=150, played_at=datetime(2025, 1, 1, tzinfo=UTC)),
    ])
    assert floor == 100
