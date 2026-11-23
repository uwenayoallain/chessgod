from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.config import settings
from app.models.analysis import AnalysisResult
from app.models.cloud_evaluation import CloudEvaluation
from app.models.base import Base
from app.models.external_sync_state import ExternalSyncState
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.services.cache import get_shared_cache
from app.services.improvement import _CANDIDATE_CACHE_VERSION
from app.services.cloud_evals import (
    CLOUD_EVAL_PROVIDER,
    CloudEval,
    LichessCloudEvalClient,
    choose_unanalyzed_positions,
    parse_cloud_eval,
    store_cloud_eval,
    sync_cloud_evals,
)


START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"


@pytest.fixture(autouse=True)
def _fast_and_clean(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "lichess_cloud_eval_request_delay", 0.0)
    get_shared_cache()._local.clear()


def build_game(game_id: int) -> Game:
    return Game(
        id=game_id,
        chesscom_game_url=f"https://chess.com/game/{game_id}",
        chesscom_game_id=str(game_id),
        username="tester",
        white_username="tester",
        black_username="opponent",
        user_color="white",
        result="1-0",
        user_result="win",
        time_class="blitz",
        time_control="600",
        white_rating=1700,
        black_rating=1700,
        pgn='[Event "Test"]\n\n1. e4 e5 1-0',
        eco="C20",
        opening_name="King Pawn Game",
        played_at=datetime(2024, 1, game_id, tzinfo=UTC),
        num_moves=2,
    )


async def make_session_factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def test_parse_cloud_eval_converts_pv_to_san() -> None:
    payload = {"depth": 36, "pvs": [{"moves": "e2e4 e7e5 g1f3", "cp": 30}]}
    evaluation = parse_cloud_eval(START_FEN, payload)
    assert evaluation is not None
    assert evaluation.depth == 36
    assert evaluation.eval_cp == 30
    assert evaluation.best_move_uci == "e2e4"
    assert evaluation.best_move_san == "e4"
    assert evaluation.pv_san == "e4 e5 Nf3"


def test_parse_cloud_eval_rejects_empty_payload() -> None:
    assert parse_cloud_eval(START_FEN, {"depth": 30, "pvs": []}) is None
    assert parse_cloud_eval(START_FEN, {"pvs": [{"moves": "e2e4"}]}) is None


@pytest.mark.asyncio
async def test_client_fetch_handles_hit_miss_and_throttle() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        fen = request.url.params["fen"]
        if fen.startswith("miss"):
            return httpx.Response(404)
        if fen.startswith("throttled"):
            return httpx.Response(429)
        return httpx.Response(
            200, json={"depth": 30, "pvs": [{"moves": "e2e4", "cp": 25}]}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        client = LichessCloudEvalClient(http_client)
        hit = await client.fetch(START_FEN)
        assert hit is not None and hit.depth == 30
        assert await client.fetch("miss w KQkq -") is None
        with pytest.raises(httpx.HTTPStatusError):
            await client.fetch("throttled w KQkq -")


@pytest.mark.asyncio
async def test_choose_unanalyzed_positions_skips_covered_and_late_plies() -> None:
    engine, session_factory = await make_session_factory()
    async with session_factory() as session:
        low_rated_game = build_game(3)
        low_rated_game.white_rating = 999
        session.add_all([build_game(1), build_game(2), low_rated_game])
        session.add_all(
            [
                Position(id=1, fen="popular", total_games=2, white_wins=1, draws=1, black_wins=0),
                Position(id=2, fen="already-covered", total_games=2, white_wins=1, draws=0, black_wins=1),
                Position(id=3, fen="middlegame", total_games=2, white_wins=1, draws=0, black_wins=1),
                Position(id=4, fen="rare", total_games=1, white_wins=1, draws=0, black_wins=0),
                Position(id=5, fen="old-low-rating", total_games=10, white_wins=5, draws=0, black_wins=5),
                Position(id=6, fen="legacy-only", total_games=1, white_wins=1, draws=0, black_wins=0),
            ]
        )
        session.add_all(
            [
                GamePosition(game_id=1, position_id=1, ply=6, move_san="e4", move_uci="e2e4"),
                GamePosition(game_id=2, position_id=1, ply=8, move_san="e4", move_uci="e2e4"),
                GamePosition(game_id=1, position_id=2, ply=4, move_san="d4", move_uci="d2d4"),
                GamePosition(game_id=2, position_id=2, ply=4, move_san="d4", move_uci="d2d4"),
                GamePosition(game_id=1, position_id=3, ply=44, move_san="Kg2", move_uci="g1g2"),
                GamePosition(game_id=2, position_id=3, ply=46, move_san="Kg2", move_uci="g1g2"),
                GamePosition(game_id=1, position_id=4, ply=10, move_san="a3", move_uci="a2a3"),
                GamePosition(game_id=3, position_id=5, ply=10, move_san="a3", move_uci="a2a3"),
                GamePosition(game_id=1, position_id=6, ply=12, move_san="a3", move_uci="a2a3"),
            ]
        )
        session.add_all(
            [
                AnalysisResult(
                    position_id=2,
                    depth=24,
                    eval_cp=15,
                    best_move_uci="d2d4",
                    best_move_san="d4",
                    multipv_rank=1,
                ),
                # Position 6 used to carry a superseded-engine row here, to
                # show it neither satisfies the contract nor suppresses a cloud
                # lookup. Since migration 018 such a row cannot live in
                # analysis_results at all, so the position simply has no
                # evaluation and must still be offered.
            ]
        )
        await session.commit()

        candidates = await choose_unanalyzed_positions(
            session, min_depth=20, max_ply=30, min_games=1, limit=10,
            min_user_rating=1000,
        )
        all_game_candidates = await choose_unanalyzed_positions(
            session,
            min_depth=20,
            max_ply=None,
            min_games=1,
            limit=10,
            min_user_rating=1000,
        )

    # Covered, late-ply, and pre-1000 positions are excluded; most-played first.
    assert candidates == [(1, "popular"), (4, "rare"), (6, "legacy-only")]
    assert (3, "middlegame") in all_game_candidates
    await engine.dispose()


@pytest.mark.asyncio
async def test_store_cloud_eval_keeps_deeper_rows() -> None:
    engine, session_factory = await make_session_factory()
    deep = CloudEval(
        depth=36, eval_cp=20, eval_mate=None,
        best_move_uci="e2e4", best_move_san="e4", pv_uci="e2e4", pv_san="e4",
    )
    shallow = CloudEval(
        depth=18, eval_cp=99, eval_mate=None,
        best_move_uci="d2d4", best_move_san="d4", pv_uci="d2d4", pv_san="d4",
    )
    async with session_factory() as session:
        session.add(Position(id=1, fen="fen-a", total_games=1, white_wins=1, draws=0, black_wins=0))
        await session.commit()

        assert await store_cloud_eval(session, position_id=1, evaluation=deep) is True
        assert await store_cloud_eval(session, position_id=1, evaluation=shallow) is False
        await session.commit()

        row = await session.scalar(
            select(CloudEvaluation).where(CloudEvaluation.position_id == 1)
        )
        assert row is not None
        assert row.engine == "lichess-cloud"
        # Never in the table the planner reads.
        assert await session.scalar(select(AnalysisResult)) is None
        assert row.depth == 36
        assert row.eval_cp == 20
    await engine.dispose()


class StubClient:
    def __init__(self, responses: dict[str, CloudEval | None | Exception]) -> None:
        self.responses = responses
        self.calls: list[str] = []

    async def fetch(self, fen: str) -> CloudEval | None:
        self.calls.append(fen)
        result = self.responses[fen]
        if isinstance(result, Exception):
            raise result
        return result


@pytest.mark.asyncio
async def test_sync_cloud_evals_stores_hits_and_remembers_misses() -> None:
    engine, session_factory = await make_session_factory()
    evaluation = CloudEval(
        depth=30, eval_cp=12, eval_mate=None,
        best_move_uci="e2e4", best_move_san="e4", pv_uci="e2e4", pv_san="e4",
    )
    async with session_factory() as session:
        session.add(build_game(1))
        session.add_all(
            [
                Position(id=1, fen="hit-fen", total_games=1, white_wins=1, draws=0, black_wins=0),
                Position(id=2, fen="miss-fen", total_games=1, white_wins=1, draws=0, black_wins=0),
            ]
        )
        session.add_all(
            [
                GamePosition(game_id=1, position_id=1, ply=2, move_san="e4", move_uci="e2e4"),
                GamePosition(game_id=1, position_id=2, ply=4, move_san="e5", move_uci="e7e5"),
            ]
        )
        await session.commit()

        candidate_cache_key = (
            f"improvement:candidates:v{_CANDIDATE_CACHE_VERSION}:tester:both:rapid_blitz:80:18:1000"
        )
        await get_shared_cache().set_json(
            candidate_cache_key, ["stale"], ttl_seconds=60
        )

        client = StubClient({"hit-fen": evaluation, "miss-fen": None})
        meta = await sync_cloud_evals(session, client)  # type: ignore[arg-type]
        assert meta["stored"] == 1
        assert meta["misses"] == 1
        assert await get_shared_cache().get_json(candidate_cache_key) is None

        # Second run: the stored hit no longer qualifies, the miss is remembered.
        meta = await sync_cloud_evals(session, client)  # type: ignore[arg-type]
        assert meta["stored"] == 0
        assert meta["skipped_known_misses"] == 1
        assert client.calls.count("hit-fen") == 1
        assert client.calls.count("miss-fen") == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_sync_cloud_evals_cools_down_on_throttle() -> None:
    engine, session_factory = await make_session_factory()
    async with session_factory() as session:
        session.add(build_game(1))
        session.add(Position(id=1, fen="any-fen", total_games=1, white_wins=1, draws=0, black_wins=0))
        session.add(GamePosition(game_id=1, position_id=1, ply=2, move_san="e4", move_uci="e2e4"))
        await session.commit()

        throttle = httpx.HTTPStatusError(
            "429",
            request=httpx.Request("GET", "https://lichess.org/api/cloud-eval"),
            response=httpx.Response(429),
        )
        client = StubClient({"any-fen": throttle})
        meta = await sync_cloud_evals(session, client)  # type: ignore[arg-type]
        assert meta["stored"] == 0

        state = await session.get(ExternalSyncState, CLOUD_EVAL_PROVIDER)
        assert state is not None and state.cooldown_until is not None

        # While cooling down, no requests go out at all.
        meta = await sync_cloud_evals(session, client)  # type: ignore[arg-type]
        assert meta["queued"] == 0
        assert len(client.calls) == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_sync_cloud_evals_rejects_evals_shallower_than_min_depth() -> None:
    """Lichess can answer shallower than we asked for.

    Storing those would mix depths in analysis_results, and mistake detection
    differences a parent against a child eval — so a shallow neighbour surfaces
    as a phantom eval drop rather than a real one.
    """
    engine, session_factory = await make_session_factory()
    shallow = CloudEval(
        depth=settings.lichess_cloud_eval_min_depth - 1,
        eval_cp=12, eval_mate=None,
        best_move_uci="e2e4", best_move_san="e4", pv_uci="e2e4", pv_san="e4",
    )
    async with session_factory() as session:
        session.add(build_game(1))
        session.add(
            Position(id=1, fen="shallow-fen", total_games=1, white_wins=1, draws=0, black_wins=0)
        )
        session.add(
            GamePosition(game_id=1, position_id=1, ply=2, move_san="e4", move_uci="e2e4")
        )
        await session.commit()

        client = StubClient({"shallow-fen": shallow})
        meta = await sync_cloud_evals(session, client)  # type: ignore[arg-type]
        assert meta["too_shallow"] == 1
        assert meta["stored"] == 0

        rows = (await session.execute(select(CloudEvaluation))).scalars().all()
        assert rows == []
    await engine.dispose()
