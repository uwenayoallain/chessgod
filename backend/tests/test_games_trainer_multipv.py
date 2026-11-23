"""Trainer positions still waiting for their second and third engine lines."""

from datetime import UTC, datetime

import chess
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import get_db
from app.engine_contract import GAME_REVIEW_DEPTH, MAX_PAIR_DEPTH_GAP
from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.training import TrainingEvent
from app.routers import games as games_router
from app.routers.games import trainer_multipv_fens
from app.utils.fen import normalize_fen

# White to move with a free choice; black to move with only ...Kh8.
OPEN_A = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -"
OPEN_B = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -"
OPEN_C = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -"
ONE_MOVE = "6k1/5Q2/6K1/8/8/8/8/8 b - -"
# Parses, and the evaluations endpoint would refuse it: the king has left e8.
UNSTORABLE = "3rnkrb/qp1ppp2/8/p6p/8/P2N4/QP1PPP1P/3RRK1B b kq -"


def _line(position_id: int, rank: int, depth: int) -> AnalysisResult:
    return AnalysisResult(
        position_id=position_id, engine="stockfish-19", engine_version="19", depth=depth,
        eval_cp=0, best_move_uci="e2e4", best_move_san="e4", multipv_rank=rank,
    )


async def _database():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.asyncio
async def test_a_blunder_check_position_is_listed_until_its_other_lines_are_stored() -> None:
    engine, session_factory = await _database()
    async with session_factory() as session:
        # 2.Qg4?? hangs the queen to ...Bxg4: Blunder Check asks the position after it.
        board = chess.Board()
        fens = [normalize_fen(board.fen())]
        session.add(Game(
            id=1, chesscom_game_url="https://chess.com/game/1", chesscom_game_id="1",
            username="tester", white_username="tester", black_username="opponent", user_color="white",
            result="0-1", user_result="loss", time_class="rapid", time_control="600",
            white_rating=1500, black_rating=1500, pgn="-",
            played_at=datetime(2026, 9, 1, tzinfo=UTC), num_moves=3,
        ))
        session.add(Position(id=1, fen=fens[0]))
        await session.flush()
        session.add(GamePosition(game_id=1, position_id=1, ply=0))
        for ply, san in enumerate(["e4", "d5", "Qg4"], start=1):
            move = board.push_san(san)
            fens.append(normalize_fen(board.fen()))
            session.add(Position(id=ply + 1, fen=fens[-1]))
            await session.flush()
            session.add(GamePosition(game_id=1, position_id=ply + 1, ply=ply,
                                     move_uci=move.uci(), move_san=san))
        session.add_all([
            AnalysisResult(position_id=3, depth=20, eval_cp=40, best_move_uci="e4d5",
                           best_move_san="exd5", multipv_rank=1),
            AnalysisResult(position_id=4, depth=20, eval_cp=-800, best_move_uci="c8g4",
                           best_move_san="Bxg4", multipv_rank=1),
        ])
        await session.commit()

        waiting = await trainer_multipv_fens(username="tester", limit=6, session=session)
        assert waiting == {"fens": [fens[3]], "review_depth": GAME_REVIEW_DEPTH}

        # A second line from a search far from the review depth is not the
        # one the trainers can use beside the first.
        session.add(_line(4, 2, GAME_REVIEW_DEPTH + MAX_PAIR_DEPTH_GAP + 1))
        await session.commit()
        assert (await trainer_multipv_fens(username="tester", limit=6, session=session))["fens"] == [fens[3]]

        # The crawler's MultiPV search lands at the review depth: done.
        session.add_all([_line(4, 2, GAME_REVIEW_DEPTH + 1), _line(4, 3, GAME_REVIEW_DEPTH + 1)])
        await session.commit()
        assert (await trainer_multipv_fens(username="tester", limit=6, session=session))["fens"] == []

        # Asking is a read: nothing the player did was recorded.
        assert await session.scalar(select(func.count()).select_from(TrainingEvent)) == 0
        assert (await trainer_multipv_fens(username="nobody", limit=6, session=session))["fens"] == []
    await engine.dispose()


@pytest.mark.asyncio
async def test_both_trainers_are_listed_newest_first_and_only_what_a_search_can_finish(monkeypatch) -> None:
    engine, session_factory = await _database()
    fens = {1: OPEN_A, 2: OPEN_B, 3: OPEN_C, 4: ONE_MOVE, 5: UNSTORABLE}
    assert chess.Board(f"{ONE_MOVE} 0 1").legal_moves.count() == 1

    def item(position_id: int, day: int) -> dict:
        return {"position_id": position_id, "fen": fens[position_id],
                "played_at": datetime(2026, 9, day, tzinfo=UTC).isoformat()}

    # Position 1 is in both pools: one search serves both trainers.
    async def punish_pool(session, username, *, min_user_rating):
        return [item(3, 7), item(1, 3)]

    async def threat_pool(session, username, *, min_user_rating):
        return [item(5, 9), item(4, 8), item(2, 5), item(1, 3)]

    monkeypatch.setattr(games_router.threats, "cached_punish_pool", punish_pool)
    monkeypatch.setattr(games_router.threats, "cached_threat_pool", threat_pool)
    async with session_factory() as session:
        session.add_all(Position(id=position_id, fen=fen) for position_id, fen in fens.items())
        await session.commit()

        # A position with one legal move can never get a second line, and one
        # the evaluations endpoint refuses can never store one: offered, they
        # would be offered forever.
        listed = await trainer_multipv_fens(username="tester", limit=25, session=session)
        assert listed["fens"] == [OPEN_C, OPEN_B, OPEN_A]

        assert (await trainer_multipv_fens(username="tester", limit=2, session=session))["fens"] == [OPEN_C, OPEN_B]

        # Candidates are checked a bounded batch at a time, and a batch that is
        # all done does not end the list: the next one is read.
        monkeypatch.setattr(games_router, "_TRAINER_BATCH", 2)
        session.add(_line(3, 2, GAME_REVIEW_DEPTH))
        await session.commit()
        assert (await trainer_multipv_fens(username="tester", limit=25, session=session))["fens"] == [OPEN_B, OPEN_A]

        # A first line alone, however deep, is not a second line.
        session.add(_line(2, 1, GAME_REVIEW_DEPTH))
        await session.commit()
        assert (await trainer_multipv_fens(username="tester", limit=25, session=session))["fens"] == [OPEN_B, OPEN_A]
    await engine.dispose()


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 26}, {"username": ""}, {"username": "x" * 65}])
def test_the_trainer_list_rejects_requests_outside_its_bounds(params) -> None:
    app = FastAPI()
    app.include_router(games_router.router, prefix="/api/games")

    async def no_database():
        yield None

    app.dependency_overrides[get_db] = no_database
    with TestClient(app) as client:
        response = client.get("/api/games/trainer-multipv-fens", params={"username": "tester", **params})
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["query", next(iter(params))]


def test_the_trainer_list_is_not_read_as_a_game_id() -> None:
    # Declared before `/{game_id}`, or the path would be parsed as a game id.
    paths = [route.path for route in games_router.router.routes]
    assert paths.index("/trainer-multipv-fens") < paths.index("/{game_id}")
