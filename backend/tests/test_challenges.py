from datetime import UTC, date, datetime, timedelta

import chess
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.services import challenges
from app.utils.fen import normalize_fen

NOW = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)


def test_the_clock_counts_as_used_when_spent_without_a_scramble() -> None:
    assert challenges.used_clock("600", 70, 120)
    assert challenges.used_clock("600+5", 60, 180)
    # Most of it left, a scramble, a short game, a daily game: none of them count.
    assert not challenges.used_clock("600", 70, 400)
    assert not challenges.used_clock("600", 70, 30)
    assert not challenges.used_clock("600", 40, 120)
    assert not challenges.used_clock("1/86400", 70, 120)
    assert not challenges.used_clock("600", 70, None)
    assert challenges.week_start(date(2026, 10, 4)) == date(2026, 9, 28)


@pytest.mark.asyncio
async def test_this_weeks_games_finish_challenges_that_pay_once() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    ids: dict[str, int] = {}

    def pid(fen: str) -> int:
        return ids.setdefault(fen, len(ids) + 1)

    def fens(sans: list[str]) -> list[str]:
        return [fen for fen, _ in walk(sans)]

    def walk(sans: list[str]) -> list[tuple[str, str | None]]:
        """Each position with the move that reached it."""
        board = chess.Board()
        out: list[tuple[str, str | None]] = [(normalize_fen(board.fen()), None)]
        for san in sans:
            uci = board.push_san(san).uci()
            out.append((normalize_fen(board.fen()), uci))
        return out

    line = ["e4", "e5", "Nf3", "Nc6", "Bc4"]
    line_fens = fens(line)
    repertoire = {
        "color": "white",
        "lines": [{
            "id": "italian",
            "name": "Italian",
            "moves": [
                {"side": "you" if index % 2 == 0 else "opponent", "fen": line_fens[index],
                 "uci": chess.Board(line_fens[index] + " 0 1").parse_san(san).uci(), "san": san}
                for index, san in enumerate(line)
            ],
        }],
    }
    rows: list = []

    def add_game(game_id: int, sans: list[str], played_at: datetime, *, plies: int = 5,
                 last_clock: float | None = None) -> None:
        rows.append(Game(
            id=game_id, chesscom_game_url=f"u{game_id}", chesscom_game_id=str(game_id), username="tester",
            white_username="tester", black_username="b", user_color="white", result="1-0", user_result="win",
            time_class="rapid", time_control="600", white_rating=1500, black_rating=1500, pgn="-",
            played_at=played_at, num_moves=plies,
        ))
        for ply, (fen, uci) in enumerate(walk(sans)):
            rows.append(GamePosition(game_id=game_id, position_id=pid(fen), ply=ply,
                                     move_uci=uci, move_san=sans[ply - 1] if ply else None))
        if last_clock is not None:
            rows.append(GamePosition(game_id=game_id, position_id=pid(f"late{game_id}"), ply=plies - 1,
                                     move_uci="x", clock_seconds_after=last_clock))

    monday = datetime(2026, 9, 28, 9, 0, tzinfo=UTC)
    # Three games in the repertoire this week, one of which also used the clock.
    add_game(1, line, monday, plies=70, last_clock=120)
    add_game(2, line, monday + timedelta(hours=1))
    add_game(3, line, monday + timedelta(hours=2))
    # Left the repertoire at 3.Bb5.
    add_game(4, ["e4", "e5", "Nf3", "Nc6", "Bb5"], monday + timedelta(hours=3))
    # In the repertoire, but last week.
    add_game(5, line, monday - timedelta(days=2))

    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add_all(Position(id=position_id, fen=fen) for fen, position_id in ids.items())
        await session.flush()
        session.add_all([row for row in rows if isinstance(row, Game)])
        await session.flush()
        session.add_all([row for row in rows if not isinstance(row, Game)])
        await session.commit()

        board, xp, paid = await challenges.settle_challenges(session, "tester", [repertoire], now=NOW)
        again = await challenges.settle_challenges(session, "tester", [repertoire], now=NOW)
    await engine.dispose()

    items = {item["key"]: item for item in board["items"]}
    assert board["week"] == "2026-09-28"
    assert board["games_this_week"] == 4
    assert items["stay_in_book"]["progress"] == 3 and items["stay_in_book"]["done"]
    assert items["use_clock"]["progress"] == 1 and not items["use_clock"]["done"]
    assert (xp, paid) == (40, ["stay_in_book"])
    assert again[1:] == (0, [])
