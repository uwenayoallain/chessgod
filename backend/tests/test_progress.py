from datetime import UTC, datetime, timedelta

import chess
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.training import TrainingEvent
from app.services.progress import build_progress, summarize
from app.utils.fen import normalize_fen

START = datetime(2026, 9, 1, tzinfo=UTC)


def _game(**extra) -> dict:
    return {"rating": 1500, "color": "white", "result": "win", "big_errors": 2, "forcing_errors": 1,
            "cp10": 0, **extra}


def test_a_run_of_games_is_averaged_per_game_and_per_colour() -> None:
    summary = summarize([
        _game(rating=1600, big_errors=4, forcing_errors=2, cp10=-150),
        _game(rating=1550, big_errors=2, forcing_errors=0, result="loss", cp10=20),
        _game(rating=1500, big_errors=0, forcing_errors=0, color="black", result="draw", cp10=None),
    ])
    assert summary["games"] == 3
    assert summary["big_errors"] == 2.0
    assert summary["forcing_errors"] == pytest.approx(0.67)
    assert summary["score"] == 0.5
    # Black's only game had no evaluation after move 10: no share rather than 0%.
    assert summary["worse_after_opening"] == {"white": 0.5}
    assert (summary["rating_from"], summary["rating_to"]) == (1500, 1600)
    assert summarize([]) is None


@pytest.mark.asyncio
async def test_games_are_measured_only_when_mostly_analysed_and_split_at_training() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    ids: dict[str, int] = {}
    rows: list = []
    evals: list = []

    def pid(fen: str) -> int:
        return ids.setdefault(fen, len(ids) + 1)

    def add_game(game_id: int, sans: list[str], scores: list[int], played_at: datetime) -> None:
        rows.append(Game(
            id=game_id, chesscom_game_url=f"u{game_id}", chesscom_game_id=str(game_id), username="tester",
            white_username="tester", black_username="b", user_color="white", result="1-0", user_result="win",
            time_class="rapid", time_control="600", white_rating=1500 + game_id, black_rating=1500, pgn="-",
            played_at=played_at, num_moves=len(sans),
        ))
        board = chess.Board()
        fens = [normalize_fen(board.fen())]
        for san in sans:
            board.push_san(san)
            fens.append(normalize_fen(board.fen()))
        for ply, fen in enumerate(fens):
            rows.append(GamePosition(game_id=game_id, position_id=pid(fen), ply=ply,
                                     move_uci="x" if ply else None, move_san=sans[ply - 1] if ply else None))
        for fen, cp in zip(fens, scores, strict=False):
            evals.append(AnalysisResult(position_id=pid(fen), depth=20, eval_cp=cp,
                                        best_move_uci="e2e4", best_move_san="Nxe5", multipv_rank=1))

    # Game 1, before training: 2.Qh5 then 3.Qxf7+?? gives it away (0.3 -> -5.0).
    add_game(1, ["e4", "e5", "Qh5", "Nc6", "Qxf7+"], [30, 30, 20, 20, 20, -500], START)
    # Game 2, after training: clean.
    add_game(2, ["d4", "d5", "c4", "e6", "Nc3"], [20, 20, 25, 25, 20, 20], START + timedelta(days=5))
    # Game 3: only the start evaluated, so it is not measured at all.
    add_game(3, ["c4", "e5", "Nc3"], [30], START + timedelta(days=6))

    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add_all(Position(id=position_id, fen=fen) for fen, position_id in ids.items())
        await session.flush()
        session.add_all([row for row in rows if isinstance(row, Game)])
        await session.flush()
        session.add_all([row for row in rows if not isinstance(row, Game)])
        # Deduplicate evaluations of shared positions (the start).
        seen: set[int] = set()
        for row in evals:
            if row.position_id not in seen:
                seen.add(row.position_id)
                session.add(row)
        session.add(TrainingEvent(username="tester", kind="quiz_answer", xp=1,
                                  created_at=START + timedelta(days=2)))
        await session.commit()
        result = await build_progress(session, username="tester", min_user_rating=1000)
    await engine.dispose()

    assert result["checked_games"] == 3
    measured = {game["game_id"]: game for game in result["games"]}
    assert set(measured) == {1, 2}
    assert measured[1]["big_errors"] == 1
    assert measured[1]["forcing_errors"] == 1
    assert measured[2]["big_errors"] == 0
    assert result["since_training"]["games"] == 1
    assert result["before_training"]["big_errors"] == 1.0
