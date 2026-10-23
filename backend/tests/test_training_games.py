from datetime import UTC, datetime, timedelta

import chess
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.training import LineMoveProgress
from app.services.training_games import (
    check_recent_games,
    expected_moves,
    rush_questions,
    score_rush,
)
from app.utils.fen import normalize_fen

NOW = datetime(2026, 9, 30, 12, tzinfo=UTC)


def fen_after(sans: list[str]) -> str:
    board = chess.Board()
    for san in sans:
        board.push_san(san)
    return normalize_fen(board.fen())


def step(sans: list[str], san: str, side: str, **extra) -> dict:
    board = chess.Board(f"{fen_after(sans)} 0 1")
    return {"ply": len(sans) + 1, "fen": fen_after(sans), "uci": board.parse_san(san).uci(),
            "san": san, "side": side, **extra}


SCOTCH = ["e4", "e5", "Nf3", "Nc6", "d4", "exd4", "Nxd4", "Nxd4", "Qxd4", "Qf6"]
BLACK = {
    "color": "black",
    "lines": [{
        "id": "scotch",
        "name": "Scotch Game",
        "moves": [
            step(SCOTCH[:index], san, "you" if index % 2 else "opponent",
                 status="change" if san == "Qf6" else "keep")
            for index, san in enumerate(SCOTCH)
        ],
    }],
}


def test_rush_asks_every_move_once_skipping_the_first_and_easiest_first() -> None:
    questions = rush_questions([BLACK, BLACK], seed=1)
    answers = [q["answer_san"] for q in questions]
    # Shuffled within a band of four plies, never across bands.
    assert sorted(answers[:2]) == ["Nc6", "exd4"]
    assert sorted(answers[2:]) == ["Nxd4", "Qf6"]
    nc6 = next(q for q in questions if q["answer_san"] == "Nc6")
    assert nc6["last_move_uci"] == "g1f3"
    assert nc6["side_to_move"] == "black"
    assert next(q for q in questions if q["answer_san"] == "Qf6")["changed"] is True


def test_unchecked_moves_are_never_quizzed_or_preached() -> None:
    # A step the engine has not vetted is only "the move you happened to play":
    # the check must not hold it up over the move played on the day, and the
    # Rush must not score a possibly better move as a miss. The step returns
    # once its position has been searched.
    unchecked = {
        "color": "black",
        "lines": [{
            "id": "scotch",
            "name": "Scotch Game",
            "moves": [
                step(SCOTCH[:index], san, "you" if index % 2 else "opponent",
                     status="keep", checked=san != "Qf6")
                for index, san in enumerate(SCOTCH)
            ],
        }],
    }
    expected = expected_moves([unchecked])
    assert fen_after(SCOTCH[:9]) not in expected
    assert fen_after(SCOTCH[:7]) in expected
    assert all(q["answer_san"] != "Qf6" for q in rush_questions([unchecked], seed=1))


def test_a_rush_ends_at_the_third_miss_and_ignores_unknown_positions() -> None:
    expected = expected_moves([BLACK])
    fens = [fen_after(SCOTCH[:n]) for n in (3, 5, 7, 9)]
    answers = [
        (fens[0], "b8c6"), ("not-a-repertoire-fen", "e2e4"), (fens[1], "a7a6"),
        (fens[2], "c6d4"), (fens[3], "g8f6"), (fens[0], "h7h6"), (fens[2], "c6d4"),
    ]
    scored = score_rush(answers, expected)
    assert scored["score"] == 2
    assert scored["missed"] == [fens[1], fens[3], fens[0]]


@pytest.mark.asyncio
async def test_recent_games_are_checked_against_the_repertoire_and_misses_come_due() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    ids: dict[str, int] = {}

    def pid(fen: str) -> int:
        return ids.setdefault(fen, len(ids) + 1)

    rows = []
    games = [
        # Yesterday: 5...Nf6 again, the move the course replaced.
        (1, [*SCOTCH[:9], "Nf6"], NOW - timedelta(days=1), "loss"),
        # Last week: the repertoire all the way.
        (2, SCOTCH, NOW - timedelta(days=7), "win"),
    ]
    for game_id, sans, played_at, result in games:
        rows.append(Game(
            id=game_id, chesscom_game_url=f"https://chess.com/game/{game_id}", chesscom_game_id=str(game_id),
            username="tester", white_username="w", black_username="tester", user_color="black",
            result="1-0", user_result=result, time_class="rapid", time_control="600",
            white_rating=1500, black_rating=1500, pgn="-", played_at=played_at, num_moves=len(sans),
        ))
        board = chess.Board()
        rows.append(GamePosition(game_id=game_id, position_id=pid(normalize_fen(board.fen())), ply=0))
        for ply, san in enumerate(sans, start=1):
            move = board.push_san(san)
            rows.append(GamePosition(game_id=game_id, position_id=pid(normalize_fen(board.fen())),
                                     ply=ply, move_uci=move.uci(), move_san=san))
    qf6 = step(SCOTCH[:9], "Qf6", "you")
    learned = LineMoveProgress(username="tester", color="black", fen=qf6["fen"], move_uci=qf6["uci"],
                               level=4, reviews=3, lapses=0, due_at=NOW + timedelta(days=5),
                               last_reviewed_at=NOW - timedelta(days=3))
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add_all(Position(id=position_id, fen=fen) for fen, position_id in ids.items())
        await session.flush()
        session.add_all([row for row in rows if isinstance(row, Game)])
        await session.flush()
        session.add_all([row for row in rows if not isinstance(row, Game)])
        session.add(learned)
        await session.commit()
        result = await check_recent_games(session, "tester", [BLACK], now=NOW)
        await session.commit()
        again = await check_recent_games(session, "tester", [BLACK], now=NOW)
    await engine.dispose()

    assert result["games_checked"] == 2
    assert result["games_followed"] == 1
    [deviation] = result["deviations"]
    assert (deviation["played_san"], deviation["expected_san"], deviation["ply"]) == ("Nf6", "Qf6", 10)
    assert deviation["result"] == "loss"
    # The learned move the player forgot over the board is due again now.
    assert result["requeued"] == 1
    assert learned.level == 1
    assert again["requeued"] == 0
