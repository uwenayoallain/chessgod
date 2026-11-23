"""Local study routes must not require a reachable external service."""
import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import get_db
from app.main import app
from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.drill_progress import DrillProgress
from app.models.position import Position
from app.services.game_ingest import insert_game
from app.services.pgn_parser import parse_game_pgn
from app.services.tree_builder import update_tree_from_game
from test_game_ingest import build_game

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"


@pytest.mark.asyncio
async def test_saved_games_evaluations_theory_and_progress_work_without_internet(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    external_attempts = []
    original_send = httpx.AsyncClient.send

    async def local_only(client, request, **kwargs):
        if request.url.host != "local.test":
            external_attempts.append(str(request.url))
            raise httpx.ConnectError("Internet is unavailable", request=request)
        return await original_send(client, request, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "send", local_only)

    async def db():
        async with sessions() as session:
            yield session
            await session.commit()

    previous = app.dependency_overrides.copy()
    app.dependency_overrides[get_db] = db
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as session:
            game = build_game("https://chess.com/game/offline", "offline", "white", "1-0", "rapid")
            game.pgn = '[White "tester"]\n[Black "opponent"]\n[Result "1-0"]\n\n1. Nf3 e5 1-0'
            game_id = await insert_game(session, game)
            await update_tree_from_game(session, game_id, parse_game_pgn(game.pgn), "1-0")
            position_id = await session.scalar(select(Position.id).where(Position.fen == START))
            session.add(AnalysisResult(position_id=position_id, depth=22, eval_cp=30,
                                       best_move_uci="e2e4", best_move_san="e4", pv_uci="e2e4"))
            await session.commit()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local.test") as client:
            for path, params in [
                ("/api/games", {"username": "TESTER"}),
                (f"/api/games/{game_id}", {}),
                ("/api/games/stats", {"username": "tester"}),
                ("/api/analysis/evaluations", {"fens": START}),
                ("/api/tree/position", {"fen": START}),
                ("/api/theory/compare", {"fen": START}),
                ("/api/improvement/plan", {"username": "tester"}),
            ]:
                response = await client.get(path, params=params)
                assert response.status_code == 200, (path, response.text)
            result = await client.post("/api/improvement/attempts", json={
                "username": "tester", "position_id": position_id,
                "expected_move_uci": "e2e4", "played_move_uci": "e2e4", "pattern_key": "calculation",
            })
            assert result.status_code == 200, result.text
            assert result.json()["correct"] is True
        async with sessions() as session:
            assert (await session.scalar(select(DrillProgress))).attempts == 1
        assert external_attempts == []
    finally:
        app.dependency_overrides = previous
        await engine.dispose()
