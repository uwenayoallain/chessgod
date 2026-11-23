from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event, select
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.analysis import AnalysisResult
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.schemas.game import AnalysisQueueExclusions
from app.services.cache import get_shared_cache
from app.database import get_db
from app.routers import games as games_router
from app.routers.games import (
    _DecisionPairTarget,
    _is_storable_fen,
    _pair_work,
    game_opening_groups,
    game_stats,
    get_opening_preview,
    unanalyzed_fens,
    list_games,
)


@pytest.mark.parametrize("parameter,value", [
    ("limit", 0), ("limit", -1), ("limit", 501),
    ("min_depth", 0), ("min_depth", 129),
    ("min_user_rating", 99), ("min_user_rating", 4001),
])
def test_analysis_queue_rejects_out_of_bounds_requests(parameter, value) -> None:
    app = FastAPI()
    app.include_router(games_router.router, prefix="/api/games")

    async def no_database():
        yield None

    app.dependency_overrides[get_db] = no_database
    with TestClient(app) as client:
        response = client.get("/api/games/unanalyzed-fens", params={
            "username": "tester", parameter: value,
        })
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["query", parameter]


@pytest.mark.parametrize("excluded", [["fen"] * 513, ["x" * 129], [""]])
def test_analysis_queue_bounds_exclusion_payload(excluded) -> None:
    app = FastAPI()
    app.include_router(games_router.router, prefix="/api/games")

    async def no_database():
        yield None

    app.dependency_overrides[get_db] = no_database
    with TestClient(app) as client:
        response = client.post("/api/games/unanalyzed-fens", params={"username": "tester"},
                               json={"exclude_fens": excluded})
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"][:2] == ["body", "exclude_fens"]


def test_queue_skips_positions_the_evaluations_endpoint_cannot_store() -> None:
    # Stale castling rights (`kq` on a board whose king has left e8) parse
    # fine, so the engine searches them happily — but the evaluations
    # validator rejects them, and the queue would re-offer them every batch
    # forever. The storable side of the same pair is still offered.
    assert not _is_storable_fen("3rnkrb/qp1ppp2/8/p6p/8/P2N4/QP1PPP1P/3RRK1B b kq -")
    assert _is_storable_fen("r3q1k1/ppp3pp/8/2Q5/8/2n4P/PPPP1PP1/R1B3K1 b - -")
    assert not _is_storable_fen("after-e4")
    assert not _is_storable_fen("invalid w - -")

    pair = _DecisionPairTarget(
        parent_position_id=1,
        parent_fen="3rnkrb/qp1ppp2/8/p6p/8/P2N4/QP1PPP1P/3RRK1B b kq -",
        child_position_id=2,
        child_fen="r3q1k1/ppp3pp/8/2Q5/8/2n4P/PPPP1PP1/R1B3K1 b - -",
        ply=30,
        think_seconds=2.0,
    )
    work = _pair_work(pair, depth_by_position={}, exact_position_ids=set(), min_depth=22)
    assert [fen for fen, _ in work] == ["r3q1k1/ppp3pp/8/2Q5/8/2n4P/PPPP1PP1/R1B3K1 b - -"]
    assert all(depth == 22 for _, depth in work)


def test_a_studied_side_is_searched_again_at_review_depth_for_the_crawler() -> None:
    # A side studied at 34 used to make its partner a depth-34 job, which one
    # throttled engine never finished. In the review band the studied side is
    # searched once more at 22 instead, and its 22 row then counts as done.
    parent = "r1bqkb1r/pppp1ppp/2n5/4p1N1/2B1n3/8/PPPP1PPP/RNBQK2R w KQkq -"
    child = "r1bqkb1r/pppp1ppp/2n5/4p1N1/2B1N3/8/PPPP1PPP/RNBQK2R b KQkq -"
    pair = _DecisionPairTarget(parent_position_id=1, parent_fen=parent,
                               child_position_id=2, child_fen=child, ply=9)
    deep = {1: 34, 2: 22}
    assert _pair_work(pair, depth_by_position=deep, exact_position_ids=set(), min_depth=22) == [(child, 34)]
    assert _pair_work(pair, depth_by_position=deep, exact_position_ids=set(), min_depth=22,
                      review_band=True) == [(parent, 22)]
    # Once the parent has its 22 row, load_depths reports it in band: done.
    assert _pair_work(pair, depth_by_position={1: 22, 2: 22}, exact_position_ids=set(),
                      min_depth=22, review_band=True) == []


@pytest.fixture
def symbolic_queue_fens(monkeypatch):
    """Isolate queue ordering tests from chess validity using their symbolic labels."""
    monkeypatch.setattr(games_router, "_is_storable_fen", lambda fen: True)


def build_game(
    game_id: int,
    url: str,
    opening_name: str,
    played_at: datetime,
    *,
    eco: str = "C20",
    user_color: str = "white",
    result: str = "1-0",
    time_class: str = "blitz",
) -> Game:
    if result == "1/2-1/2":
        user_result = "draw"
    elif result == "1-0":
        user_result = "win"
    else:
        user_result = "loss"
    return Game(
        id=game_id,
        chesscom_game_url=url,
        chesscom_game_id=str(game_id),
        username="tester",
        white_username="tester",
        black_username="opponent",
        user_color=user_color,
        result=result,
        user_result=user_result,
        time_class=time_class,
        time_control="600",
        white_rating=1200,
        black_rating=1200,
        pgn='[Event "Test"]\n[Site "?"]\n[Date "2024.01.01"]\n[Round "-"]\n[White "tester"]\n[Black "opponent"]\n[Result "1-0"]\n\n1. e4 e5 1-0',
        eco=eco,
        opening_name=opening_name,
        played_at=played_at,
        num_moves=2,
    )


@pytest.mark.asyncio
async def test_list_games_filters_by_position_and_opening() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                Position(
                    id=1,
                    fen="start",
                    total_games=2,
                    white_wins=2,
                    draws=0,
                    black_wins=0,
                ),
                Position(
                    id=2,
                    fen="fen-a",
                    total_games=1,
                    white_wins=1,
                    draws=0,
                    black_wins=0,
                ),
                Position(
                    id=3,
                    fen="fen-b",
                    total_games=1,
                    white_wins=1,
                    draws=0,
                    black_wins=0,
                ),
            ]
        )
        session.add_all(
            [
                build_game(
                    1,
                    "https://chess.com/game/1",
                    "King Pawn Game",
                    datetime(2024, 1, 2, tzinfo=UTC),
                ),
                build_game(
                    2,
                    "https://chess.com/game/2",
                    "Queen Pawn Game",
                    datetime(2024, 1, 1, tzinfo=UTC),
                    eco="D00",
                ),
            ]
        )
        session.add_all(
            [
                GamePosition(
                    game_id=1, position_id=1, ply=0, move_san=None, move_uci=None
                ),
                GamePosition(
                    game_id=1, position_id=2, ply=1, move_san="e4", move_uci="e2e4"
                ),
                GamePosition(
                    game_id=2, position_id=1, ply=0, move_san=None, move_uci=None
                ),
                GamePosition(
                    game_id=2, position_id=3, ply=1, move_san="d4", move_uci="d2d4"
                ),
            ]
        )
        await session.commit()

        by_fen = await list_games(
            username="tester",
            color="both",
            time_class=None,
            user_result=None,
            eco=None,
            opening_name=None,
            fen="fen-a",
            page=1,
            per_page=20,
            session=session,
        )
        assert [game.id for game in by_fen.games] == [1]
        assert by_fen.games[0].has_analysis is False

        by_opening = await list_games(
            username="tester",
            color="both",
            time_class=None,
            user_result=None,
            eco=None,
            opening_name="Queen Pawn Game",
            fen=None,
            page=1,
            per_page=20,
            session=session,
        )
        assert [game.id for game in by_opening.games] == [2]

    await engine.dispose()


@pytest.mark.asyncio
async def test_list_games_marks_games_with_saved_analysis() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                build_game(1, "https://chess.com/game/1", "Italian Game", datetime(2024, 1, 2, tzinfo=UTC)),
                build_game(2, "https://chess.com/game/2", "Italian Game", datetime(2024, 1, 1, tzinfo=UTC)),
            ]
        )
        session.add_all(
            [
                Position(id=1, fen="analyzed", total_games=1, white_wins=1, draws=0, black_wins=0),
                Position(id=2, fen="plain", total_games=1, white_wins=1, draws=0, black_wins=0),
            ]
        )
        session.add_all(
            [
                GamePosition(game_id=1, position_id=1, ply=1, move_san="e4", move_uci="e2e4"),
                GamePosition(game_id=2, position_id=2, ply=1, move_san="d4", move_uci="d2d4"),
            ]
        )
        session.add(
            AnalysisResult(
                position_id=1,
                depth=20,
                eval_cp=20,
                best_move_uci="e2e4",
                best_move_san="e4",
                multipv_rank=1,
            )
        )
        await session.commit()

        result = await list_games(
            username="tester",
            color="both",
            time_class=None,
            user_result=None,
            eco=None,
            opening_name=None,
            fen=None,
            page=1,
            per_page=20,
            session=session,
        )

        assert [(game.id, game.has_analysis) for game in result.games] == [(1, True), (2, False)]

    await engine.dispose()


@pytest.mark.usefixtures("symbolic_queue_fens")
@pytest.mark.asyncio
async def test_unanalyzed_fens_returns_depth_coverage_metadata() -> None:
    get_shared_cache()._local.clear()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add(build_game(1, "https://chess.com/game/1", "Italian Game", datetime(2024, 1, 1, tzinfo=UTC)))
        old_game = build_game(
            2,
            "https://chess.com/game/2",
            "Italian Game",
            datetime(2023, 1, 1, tzinfo=UTC),
        )
        old_game.white_rating = 999
        session.add(old_game)
        session.add_all(
            [
                Position(id=1, fen="start", total_games=1, white_wins=1, draws=0, black_wins=0),
                Position(id=2, fen="after-e4", total_games=1, white_wins=1, draws=0, black_wins=0),
                Position(id=3, fen="after-e5", total_games=1, white_wins=1, draws=0, black_wins=0),
                Position(id=4, fen="old-low-rating", total_games=1, white_wins=0, draws=0, black_wins=1),
            ]
        )
        session.add_all(
            [
                GamePosition(game_id=1, position_id=1, ply=0, move_san=None, move_uci=None),
                GamePosition(game_id=1, position_id=2, ply=1, move_san="e4", move_uci="e2e4"),
                GamePosition(game_id=1, position_id=3, ply=2, move_san="e5", move_uci="e7e5"),
                GamePosition(game_id=2, position_id=4, ply=1, move_san="d4", move_uci="d2d4"),
            ]
        )
        session.add(
            AnalysisResult(
                position_id=1,
                depth=20,
                eval_cp=20,
                best_move_uci="e2e4",
                best_move_san="e4",
                multipv_rank=1,
            )
        )
        await session.commit()

        payload = await unanalyzed_fens(
            username="tester",
            color="both",
            time_class=None,
            min_depth=20,
            limit=1,
            session=session,
        )

        assert len(payload["fens"]) == 1
        assert payload["fens"][0] in {"after-e4", "after-e5"}
        assert payload["candidate_count"] == 3
        assert payload["analyzed_count"] == 1
        assert payload["missing_count"] == 2
        assert payload["limit"] == 1
        assert payload["min_depth"] == 20
        assert payload["min_user_rating"] == 1000

    await engine.dispose()


@pytest.mark.usefixtures("symbolic_queue_fens")
@pytest.mark.asyncio
async def test_unanalyzed_fens_prefers_recent_game_positions_in_move_order() -> None:
    get_shared_cache()._local.clear()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                build_game(1, "https://chess.com/game/1", "Italian Game", datetime(2024, 1, 1, tzinfo=UTC)),
                build_game(2, "https://chess.com/game/2", "Italian Game", datetime(2024, 1, 3, tzinfo=UTC)),
            ]
        )
        session.add_all(
            [
                Position(id=1, fen="rare", total_games=1, white_wins=1, draws=0, black_wins=0),
                Position(id=2, fen="common", total_games=5, white_wins=3, draws=1, black_wins=1),
                Position(id=3, fen="uncommon", total_games=2, white_wins=1, draws=0, black_wins=1),
            ]
        )
        session.add_all(
            [
                GamePosition(game_id=1, position_id=1, ply=1, move_san="e4", move_uci="e2e4"),
                GamePosition(game_id=2, position_id=2, ply=8, move_san="Nf3", move_uci="g1f3"),
                GamePosition(game_id=2, position_id=3, ply=2, move_san="d4", move_uci="d2d4"),
            ]
        )
        await session.commit()

        payload = await unanalyzed_fens(
            username="tester",
            color="both",
            time_class=None,
            min_depth=20,
            limit=3,
            session=session,
        )

        assert payload["fens"] == ["uncommon", "common", "rare"]
        assert (
            payload["selection_strategy"]
            == "phase_balanced_recent_decision_pairs_then_recurrence"
        )
        skipped = await unanalyzed_fens(
            username="tester", color="both", min_depth=20, limit=3, session=session,
            exclusions=AnalysisQueueExclusions(exclude_fens=["uncommon", "common"]),
        )
        assert skipped["fens"] == ["rare"]
        assert skipped["candidate_count"] == payload["candidate_count"]
        assert skipped["analyzed_count"] == payload["analyzed_count"]
        assert skipped["missing_count"] == payload["missing_count"]
    await engine.dispose()


@pytest.mark.usefixtures("symbolic_queue_fens")
@pytest.mark.asyncio
async def test_unanalyzed_fens_balances_complete_recent_decision_pairs_by_phase() -> None:
    get_shared_cache()._local.clear()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add(
            build_game(
                1,
                "https://chess.com/game/1",
                "Italian Game",
                datetime(2026, 1, 1, tzinfo=UTC),
            )
        )
        labels = (
            "opening-parent",
            "opening-child",
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
            "middle-child",
            "end-parent",
            "end-child",
        )
        session.add_all(
            [
                Position(id=index, fen=label, total_games=1)
                for index, label in enumerate(labels, start=1)
            ]
        )
        session.add_all(
            [
                GamePosition(game_id=1, position_id=1, ply=0),
                GamePosition(
                    game_id=1, position_id=2, ply=1, move_san="e4", move_uci="e2e4"
                ),
                GamePosition(
                    game_id=1, position_id=3, ply=30, move_san="a6", move_uci="a7a6"
                ),
                GamePosition(
                    game_id=1, position_id=4, ply=31, move_san="Ba4", move_uci="b5a4"
                ),
                GamePosition(
                    game_id=1, position_id=5, ply=62, move_san="Kh7", move_uci="g8h7"
                ),
                GamePosition(
                    game_id=1, position_id=6, ply=63, move_san="Kf2", move_uci="g1f2"
                ),
            ]
        )
        await session.commit()

        payload = await unanalyzed_fens(
            username="tester",
            color="both",
            time_class="rapid_blitz",
            min_depth=20,
            limit=6,
            session=session,
        )

        assert payload["fens"] == [
            "end-parent",
            "end-child",
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
            "middle-child",
            "opening-parent",
            "opening-child",
        ]
        assert (
            payload["selection_strategy"]
            == "phase_balanced_recent_decision_pairs_then_recurrence"
        )
        assert payload["selected_decision_pairs_by_phase"] == {
            "endgame": 1,
            "middlegame": 1,
            "opening": 1,
        }
        skipped = await unanalyzed_fens(
            username="tester", color="both", time_class="rapid_blitz", min_depth=20,
            limit=6, session=session, exclusions=AnalysisQueueExclusions(exclude_fens=[
                "end-parent", "end-child",
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            ]),
        )
        assert set(skipped["fens"]) == {"opening-parent", "opening-child", "middle-child"}
        assert skipped["selected_decision_pairs_by_phase"] == {
            "endgame": 0, "middlegame": 0, "opening": 1,
        }
        assert skipped["missing_count"] == payload["missing_count"]

    await engine.dispose()


@pytest.mark.usefixtures("symbolic_queue_fens")
@pytest.mark.asyncio
async def test_unanalyzed_fens_advances_past_completed_recent_pairs(monkeypatch) -> None:
    get_shared_cache()._local.clear()
    monkeypatch.setattr(games_router, "_MIN_RECENT_DECISIONS", 1)
    monkeypatch.setattr(games_router, "_RECENT_DECISION_OVERFETCH", 1)
    monkeypatch.setattr(games_router, "_GAME_CHUNK_START", 1)
    monkeypatch.setattr(games_router, "_GAME_CHUNK_MAX", 1)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    game_scans: list[str] = []

    @event.listens_for(engine.sync_engine, "before_cursor_execute")
    def capture_game_pages(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith("SELECT games.id"):
            game_scans.append(statement)

    async with session_factory() as session:
        session.add_all(
            [
                build_game(
                    1,
                    "https://chess.com/game/1",
                    "Italian Game",
                    datetime(2024, 1, 1, tzinfo=UTC),
                ),
                build_game(
                    2,
                    "https://chess.com/game/2",
                    "Italian Game",
                    datetime(2024, 1, 1, tzinfo=UTC),
                ),
            ]
        )
        labels = (
            "recent-start",
            "recent-white-one",
            "recent-black-one",
            "recent-white-two",
            "recent-orphan",
            "end-parent",
            "end-child",
        )
        session.add_all(
            [
                Position(id=index, fen=label, total_games=1)
                for index, label in enumerate(labels, start=1)
            ]
        )
        session.add_all(
            [
                GamePosition(game_id=2, position_id=1, ply=0),
                GamePosition(game_id=2, position_id=2, ply=1, move_uci="e2e4"),
                GamePosition(game_id=2, position_id=3, ply=2, move_uci="e7e5"),
                GamePosition(game_id=2, position_id=4, ply=3, move_uci="g1f3"),
                GamePosition(game_id=2, position_id=5, ply=4, move_uci="b8c6"),
                GamePosition(game_id=1, position_id=6, ply=62, move_uci="g8h7"),
                GamePosition(game_id=1, position_id=7, ply=63, move_uci="g1f2"),
            ]
        )
        session.add_all(
            [
                AnalysisResult(
                    position_id=position_id,
                    depth=20,
                    eval_cp=0,
                    best_move_uci="e2e4",
                    best_move_san="e4",
                    multipv_rank=1,
                )
                for position_id in range(1, 5)
            ]
        )
        await session.commit()

        payload = await unanalyzed_fens(
            username="tester",
            color="both",
            time_class="rapid_blitz",
            min_depth=20,
            limit=2,
            session=session,
        )

        assert payload["fens"] == ["end-parent", "end-child"]
        # Equal timestamps must advance by ID, and every page stays bounded, so
        # the walk terminates instead of re-reading the newest game forever.
        # The exact number of pages is not the contract — it drops as the walk
        # gets better at filling its target from one page — but it must be more
        # than one, and each must be limited.
        assert len(game_scans) == 3  # two games, then the empty end-of-history page
        assert all("LIMIT" in statement for statement in game_scans)

    await engine.dispose()


@pytest.mark.usefixtures("symbolic_queue_fens")
@pytest.mark.asyncio
async def test_unanalyzed_fens_gives_each_phase_a_share_of_the_page(monkeypatch) -> None:
    """The candidate pool must carry every phase, not just the early plies.

    The phase rotation downstream can only rotate between phases that have
    candidates. Ordering a page by ply and keeping the first N gives the opening
    and early middlegame of the newest game, so endgames never arrive: measured
    on the real library with 26,663 endgame decisions still needing work, a
    24-position batch surfaced one.
    """

    get_shared_cache()._local.clear()
    monkeypatch.setattr(games_router, "_MIN_RECENT_DECISIONS", 6)
    monkeypatch.setattr(games_router, "_RECENT_DECISION_OVERFETCH", 1)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    full_material = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"
    bare_kings = "8/8/4k3/8/8/4K3/8/8"

    async with session_factory() as session:
        session.add(build_game(1, "https://chess.com/game/1", "Long Game",
                               datetime(2026, 6, 1, tzinfo=UTC)))
        position_id = 0
        rows = []
        # Ten opening decisions come first in ply order, then middlegame, then
        # endgame. A pool taken as "the first N by ply" is all opening.
        for ply, placement in (
            *[(p, full_material) for p in range(0, 20)],
            *[(p, full_material) for p in range(20, 60)],
            *[(p, bare_kings) for p in range(60, 80)],
        ):
            position_id += 1
            session.add(Position(id=position_id, fen=f"{placement} w - - 0 {ply}", total_games=1))
            rows.append(GamePosition(
                game_id=1, position_id=position_id, ply=ply,
                move_san=None if ply == 0 else "Nf6",
                move_uci=None if ply == 0 else "g8f6",
            ))
        session.add_all(rows)
        await session.commit()

        payload = await unanalyzed_fens(
            username="tester", color="both", time_class="rapid_blitz",
            min_depth=20, limit=6, session=session,
        )

        phases = payload["selected_decision_pairs_by_phase"]
        assert phases["opening"] > 0
        assert phases["middlegame"] > 0
        assert phases["endgame"] > 0, "endgames never reach the queue"

    await engine.dispose()


@pytest.mark.usefixtures("symbolic_queue_fens")
def test_analysis_queue_finishes_partial_pairs_before_starting_new_pairs() -> None:
    pair = games_router._DecisionPairTarget
    # Newest first within this one phase. The two older half-analyzed decisions
    # can both be completed with the same budget as the newest unevaluated pair.
    fens, counts, depths = games_router._phase_balanced_pair_fens(
        [pair(1, "new-parent", 2, "new-child", 1),
         pair(3, "partial-parent", 4, "partial-child", 3),
         pair(5, "older-parent", 6, "older-child", 5)],
        depth_by_position={3: 22, 6: 22}, min_depth=22, limit=2,
    )
    assert fens == ["partial-child", "older-parent"]
    assert counts["opening"] == 2
    # Each half-pair is searched to the depth its partner already carries.
    assert depths == {"partial-child": 22, "older-parent": 22}


@pytest.mark.usefixtures("symbolic_queue_fens")
def test_post_opening_queue_prefers_the_moves_the_player_thought_longest_about() -> None:
    pair = games_router._DecisionPairTarget
    # Measured over 210 decisions from the real library at depth 22: moves
    # played in under a second were wrong 8% of the time, moves thought about
    # for 15 seconds or more were wrong 53% of the time. The snap move is
    # usually forced; the long think marks a position the player found hard.
    middlegame = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 "
    fens, _, _ = games_router._phase_balanced_pair_fens(
        [pair(1, middlegame + "21", 2, "snap-child", 21, 0.4),
         pair(3, middlegame + "23", 4, "long-think-child", 23, 42.0),
         pair(5, middlegame + "25", 6, "ordinary-child", 25, 3.5)],
        depth_by_position={}, min_depth=22, limit=2,
    )

    assert fens == [middlegame + "23", "long-think-child"]


@pytest.mark.usefixtures("symbolic_queue_fens")
def test_an_unclocked_decision_sorts_with_the_median_not_last() -> None:
    pair = games_router._DecisionPairTarget
    # Plenty of imported games carry no clock times. A missing clock is not
    # evidence the move was easy, so it must not sink below a snap move.
    middlegame = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 "
    fens, _, _ = games_router._phase_balanced_pair_fens(
        [pair(1, middlegame + "21", 2, "snap-child", 21, 0.2),
         pair(3, middlegame + "23", 4, "unclocked-child", 23, None)],
        depth_by_position={}, min_depth=22, limit=2,
    )

    assert fens == [middlegame + "23", "unclocked-child"]


@pytest.mark.usefixtures("symbolic_queue_fens")
def test_think_time_does_not_outrank_finishing_a_half_measured_pair() -> None:
    pair = games_router._DecisionPairTarget
    # One search completes the half-measured decision; the long think needs two.
    middlegame = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 "
    fens, _, _ = games_router._phase_balanced_pair_fens(
        [pair(1, middlegame + "21", 2, "long-think-child", 21, 60.0),
         pair(3, middlegame + "23", 4, "partial-child", 23, 0.3)],
        depth_by_position={3: 22}, min_depth=22, limit=1,
    )

    assert fens == ["partial-child"]


@pytest.mark.usefixtures("symbolic_queue_fens")
@pytest.mark.asyncio
async def test_unanalyzed_fens_rotates_across_eras_of_the_players_history() -> None:
    """Coverage must not pile into the newest games.

    A newest-first walk fills up long before it reaches old games: measured on
    the real library after a crawl session, the current month held 379 distinct
    covered decisions against 19-42 for every earlier month. That is not just
    unfair to old games, it makes the library untestable — scoring the drill
    ranking compares an older window against a recent one, and the older window
    stays empty forever, so the answer is always "insufficient evidence".
    """

    get_shared_cache()._local.clear()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        # Far more recent games than the walk will ever collect, plus one game
        # from three years earlier that a recency walk can never reach.
        # Enough to exhaust both the game-page chunk and the pair target, so a
        # walk without era rotation stops long before it reaches 2023.
        recent_games = max(
            games_router._GAME_CHUNK_MAX,
            games_router._MIN_RECENT_DECISIONS,
            24 * games_router._RECENT_DECISION_OVERFETCH,
        ) + 20
        for game_id in range(1, recent_games + 1):
            session.add(build_game(game_id, f"https://chess.com/game/{game_id}",
                                   "Recent Line", datetime(2026, 6, 1, tzinfo=UTC)))
            parent_id, child_id = game_id * 2 - 1, game_id * 2
            session.add_all([
                Position(id=parent_id, fen=f"recent-parent-{game_id}", total_games=1),
                Position(id=child_id, fen=f"recent-child-{game_id}", total_games=1),
                GamePosition(game_id=game_id, position_id=parent_id, ply=30),
                GamePosition(game_id=game_id, position_id=child_id, ply=31,
                             move_san="Nf6", move_uci="g8f6"),
            ])

        old_game = recent_games + 1
        session.add(build_game(old_game, "https://chess.com/game/old", "Old Line",
                               datetime(2023, 6, 1, tzinfo=UTC)))
        session.add_all([
            Position(id=old_game * 2 - 1, fen="old-parent", total_games=1),
            Position(id=old_game * 2, fen="old-child", total_games=1),
            GamePosition(game_id=old_game, position_id=old_game * 2 - 1, ply=30),
            GamePosition(game_id=old_game, position_id=old_game * 2, ply=31,
                         move_san="Nf6", move_uci="g8f6"),
        ])
        await session.commit()

        payload = await unanalyzed_fens(
            username="tester", color="both", time_class="rapid_blitz",
            min_depth=20, limit=24, session=session,
        )

        assert "old-parent" in payload["fens"]
        assert "old-child" in payload["fens"]

    await engine.dispose()


@pytest.mark.usefixtures("symbolic_queue_fens")
def test_the_opening_bucket_keeps_recency_and_is_not_reordered() -> None:
    pair = games_router._DecisionPairTarget
    # The opening bucket was ordered by recurrence for a while. It unlocked more
    # decision *instances* per batch but the same number of distinct decisions,
    # and it steered coverage into the player's memorised main lines, where
    # measured mistake rates were 4.7% against 21.0% elsewhere. Think time does
    # not take its place either — that signal was only measured after the
    # opening. Newest first, and nothing else.
    fens, _, _ = games_router._phase_balanced_pair_fens(
        [pair(1, "newest-parent", 2, "newest-child", 5, 0.2),
         pair(3, "older-parent", 4, "older-child", 5, 90.0)],
        depth_by_position={}, min_depth=22, limit=2,
    )

    assert fens == ["newest-parent", "newest-child"]


@pytest.mark.asyncio
async def test_opening_groups_and_preview_use_most_recent_game() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                build_game(
                    1,
                    "https://chess.com/game/1",
                    "Italian Game",
                    datetime(2024, 1, 1, tzinfo=UTC),
                ),
                build_game(
                    2,
                    "https://chess.com/game/2",
                    "Italian Game",
                    datetime(2024, 1, 3, tzinfo=UTC),
                ),
                build_game(
                    3,
                    "https://chess.com/game/3",
                    "French Defense",
                    datetime(2024, 1, 2, tzinfo=UTC),
                    eco="C00",
                ),
            ]
        )
        await session.commit()

        groups = await game_opening_groups(
            username="tester",
            color="both",
            time_class=None,
            page=1,
            per_page=10,
            session=session,
        )
        assert [opening.opening_name for opening in groups.openings] == [
            "Italian Game",
            "French Defense",
        ]
        assert groups.openings[0].representative_game_id == 2

        preview = await get_opening_preview(
            username="tester",
            opening_name="Italian Game",
            eco=None,
            color="both",
            time_class=None,
            session=session,
        )
        assert preview.representative_game.id == 2
        assert preview.opening_name == "Italian Game"

    await engine.dispose()


@pytest.mark.asyncio
async def test_game_stats_returns_result_breakdown_per_time_class() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                build_game(
                    1,
                    "https://chess.com/game/1",
                    "Italian Game",
                    datetime(2024, 1, 1, tzinfo=UTC),
                    result="1-0",
                    time_class="blitz",
                ),
                build_game(
                    2,
                    "https://chess.com/game/2",
                    "Italian Game",
                    datetime(2024, 1, 2, tzinfo=UTC),
                    result="0-1",
                    time_class="blitz",
                ),
                build_game(
                    3,
                    "https://chess.com/game/3",
                    "French Defense",
                    datetime(2024, 1, 3, tzinfo=UTC),
                    result="1/2-1/2",
                    time_class="blitz",
                ),
                build_game(
                    4,
                    "https://chess.com/game/4",
                    "Caro-Kann",
                    datetime(2024, 1, 4, tzinfo=UTC),
                    result="1-0",
                    time_class="rapid",
                ),
            ]
        )
        await session.commit()

        stats = await game_stats(username="tester", time_class=None, session=session)

        assert stats.total_games == 4
        assert stats.by_time_class["blitz"].games == 3
        assert stats.by_time_class["blitz"].wins == 1
        assert stats.by_time_class["blitz"].losses == 1
        assert stats.by_time_class["blitz"].draws == 1
        assert stats.by_time_class["rapid"].games == 1
        assert stats.by_time_class["rapid"].wins == 1
        assert stats.by_time_class["rapid"].losses == 0
        assert stats.by_time_class["rapid"].draws == 0

    await engine.dispose()


@pytest.mark.usefixtures("symbolic_queue_fens")
@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("child_depth", "expected_fens", "expected_depth"),
    [
        # The parent was studied on the board at depth 30. Re-running it at the
        # review depth would be discarded by the browser's own depth-max cache,
        # so the child is searched to 30 instead — the pair becomes gradeable
        # and the measurement is better than it would have been at 22.
        (None, ["after-e4"], 30),
        (22, ["after-e4"], 30),
        # Already comparable: nothing to do.
        (30, [], None),
    ],
)
async def test_unanalyzed_fens_brings_a_pair_to_one_shared_depth(
    child_depth, expected_fens, expected_depth
) -> None:
    """A decision needs both of its positions at a depth they share.

    Studying a position on the board searches it to the interactive depth while
    the crawl runs at the review depth. A parent at 30 differenced against a
    child at 22 charges the eight extra plies of search to the player, so the
    shallower side is brought up to the deeper one rather than the reverse.
    """

    get_shared_cache()._local.clear()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add(
            build_game(1, "https://chess.com/game/1", "Italian Game", datetime(2024, 1, 1, tzinfo=UTC))
        )
        session.add_all(
            [
                Position(id=1, fen="start", total_games=1),
                Position(id=2, fen="after-e4", total_games=1),
            ]
        )
        session.add_all(
            [
                GamePosition(game_id=1, position_id=1, ply=0),
                GamePosition(game_id=1, position_id=2, ply=1, move_san="e4", move_uci="e2e4"),
            ]
        )
        session.add(
            AnalysisResult(
                position_id=1,
                depth=30,
                eval_cp=20,
                best_move_uci="e2e4",
                best_move_san="e4",
                multipv_rank=1,
            )
        )
        if child_depth is not None:
            session.add(
                AnalysisResult(
                    position_id=2,
                    depth=child_depth,
                    eval_cp=15,
                    best_move_uci="e7e5",
                    best_move_san="e5",
                    multipv_rank=1,
                )
            )
        await session.commit()

        payload = await unanalyzed_fens(
            username="tester",
            color="both",
            time_class=None,
            min_depth=22,
            limit=24,
            session=session,
        )
        assert payload["fens"] == expected_fens
        if expected_depth is not None:
            assert payload["fen_depths"] == {"after-e4": expected_depth}

    await engine.dispose()


@pytest.mark.asyncio
async def test_opening_groups_lead_with_the_openings_actually_played() -> None:
    """Frequency first, recency only as the tie-break.

    Ordered by recency the list opened with whatever was played last, so a line
    played once sat above an opening played hundreds of times — and the list is
    paginated, so the openings that describe a player's repertoire could be
    pages deep.
    """
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        games = [
            # Played once, and most recently of all.
            build_game(1, "https://chess.com/game/1", "Grob Attack", datetime(2026, 9, 1, tzinfo=UTC)),
        ]
        for i in range(2, 6):
            games.append(
                build_game(
                    i,
                    f"https://chess.com/game/{i}",
                    "Italian Game",
                    datetime(2024, 1, i, tzinfo=UTC),
                )
            )
        for i in range(6, 8):
            games.append(
                build_game(
                    i,
                    f"https://chess.com/game/{i}",
                    "French Defense",
                    datetime(2025, 1, 1, tzinfo=UTC),
                    eco="C00",
                )
            )
        session.add_all(games)
        await session.commit()

        groups = await game_opening_groups(
            username="tester",
            color="both",
            time_class=None,
            page=1,
            per_page=10,
            session=session,
        )

        assert [(o.opening_name, o.game_count) for o in groups.openings] == [
            ("Italian Game", 4),
            ("French Defense", 2),
            ("Grob Attack", 1),
        ]


@pytest.mark.asyncio
async def test_queue_filters_invalid_boards_with_real_fens() -> None:
    get_shared_cache()._local.clear()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    invalid = "3rnkrb/qp1ppp2/8/p6p/8/P2N4/QP1PPP1P/3RRK1B b kq -"
    valid = "r3q1k1/ppp3pp/8/2Q5/8/2n4P/PPPP1PP1/R1B3K1 b - -"
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            session.add(build_game(1, "https://chess.com/game/1", "Legacy", datetime(2024, 1, 1, tzinfo=UTC)))
            session.add_all([
                Position(id=1, fen=invalid, total_games=1),
                Position(id=2, fen="malformed w - -", total_games=1),
                Position(id=3, fen=valid, total_games=1),
            ])
            session.add_all([
                GamePosition(game_id=1, position_id=index + 1, ply=index)
                for index in range(3)
            ])
            await session.commit()
            for _ in range(2):
                result = await unanalyzed_fens(
                    username="tester", color="both", time_class=None,
                    min_depth=22, limit=5, min_user_rating=1000, session=session,
                )
                assert result["fens"] == [valid]
                assert result["fen_depths"] == {valid: 22}
    finally:
        await engine.dispose()


@pytest.mark.usefixtures("symbolic_queue_fens")
@pytest.mark.asyncio
async def test_unanalyzed_fens_reuses_its_pool_and_skips_what_was_analyzed_since(monkeypatch) -> None:
    """The crawler asks every batch; the library walk must not run every time,
    and a position searched since the pool was built must not be offered again."""

    get_shared_cache()._local.clear()
    monkeypatch.setattr(games_router, "_MIN_RECENT_DECISIONS", 40)
    monkeypatch.setattr(games_router, "_RECENT_DECISION_OVERFETCH", 1)
    monkeypatch.setattr(games_router, "_POOL_REFILL_FACTOR", 1)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    middlegame = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0"
    async with session_factory() as session:
        position_id = 0
        for game_id in range(1, 11):
            session.add(build_game(game_id, f"https://chess.com/game/{game_id}", "Middlegames",
                                   datetime(2026, 6, game_id, tzinfo=UTC)))
            for ply in range(20, 24):
                position_id += 1
                session.add(Position(id=position_id, fen=f"{middlegame} {game_id}-{ply}", total_games=1))
                session.add(GamePosition(game_id=game_id, position_id=position_id, ply=ply,
                                         move_san="Nf6", move_uci="g8f6"))
        await session.commit()

        pair_queries = 0

        def count_pair_queries(conn, cursor, statement, parameters, context, executemany):
            nonlocal pair_queries
            if "phase_rank" in statement:
                pair_queries += 1

        event.listen(engine.sync_engine, "before_cursor_execute", count_pair_queries)
        first = await unanalyzed_fens(username="tester", color="both", time_class="rapid_blitz",
                                      min_depth=20, limit=4, session=session)
        walked = pair_queries
        assert walked > 0 and len(first["fens"]) == 4

        # The crawler searches and uploads the batch it was given.
        fen_ids = {p.fen: p.id for p in (await session.execute(select(Position))).scalars()}
        for fen in first["fens"]:
            session.add(AnalysisResult(position_id=fen_ids[fen], engine="stockfish-19",
                                       engine_version="19", depth=20, eval_cp=0,
                                       best_move_uci="e2e4", best_move_san="e4",
                                       multipv_rank=1))
        await session.commit()

        second = await unanalyzed_fens(username="tester", color="both", time_class="rapid_blitz",
                                       min_depth=20, limit=4, session=session)
        event.remove(engine.sync_engine, "before_cursor_execute", count_pair_queries)

    assert pair_queries == walked, "the second request walked the library again"
    assert len(second["fens"]) == 4
    assert not set(second["fens"]) & set(first["fens"])
    await engine.dispose()


async def _queue_library(decisions, *, depths):
    """An in-memory library of `(game_id, played_on, [(ply, label), ...])` games.

    Every label is a position; `depths` gives the ones already searched."""

    get_shared_cache()._local.clear()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    ids: dict[str, int] = {}
    async with session_factory() as session:
        for game_id, played_on, plies in decisions:
            session.add(build_game(game_id, f"https://chess.com/game/{game_id}", "Italian Game",
                                   datetime(2024, 1, played_on, tzinfo=UTC)))
            for ply, label in plies:
                if label not in ids:
                    ids[label] = len(ids) + 1
                    session.add(Position(id=ids[label], fen=label, total_games=1))
                session.add(GamePosition(game_id=game_id, position_id=ids[label], ply=ply,
                                         move_san="e4", move_uci=None if ply == 0 else "e2e4"))
        for label, depth in depths.items():
            session.add(AnalysisResult(position_id=ids[label], engine="stockfish-19",
                                       engine_version="19", depth=depth, eval_cp=0,
                                       best_move_uci="e2e4", best_move_san="e4", multipv_rank=1))
        await session.commit()
    return engine, session_factory


@pytest.mark.usefixtures("symbolic_queue_fens")
@pytest.mark.asyncio
# The SQL exclusion of already-read pairs is an optimisation with a cap; the
# answer must not depend on it.
@pytest.mark.parametrize("sql_cap", [4000, 1, 0])
async def test_already_comparable_deep_pairs_do_not_use_up_a_pages_share(monkeypatch, sql_cap) -> None:
    monkeypatch.setattr(games_router, "_SEEN_PAIRS_IN_SQL", sql_cap)
    """The player's main-line openings are searched to 34 on both sides.

    The SQL admits them as work (a side past the review band) and Python drops
    them, but they were ranked first in the page, so they took the opening's
    whole share and the real work behind them in the same page was never read.
    Measured on the live library: a 200-pair walk came back holding 11 pairs.
    """

    monkeypatch.setattr(games_router, "_MIN_RECENT_DECISIONS", 3)
    monkeypatch.setattr(games_router, "_RECENT_DECISION_OVERFETCH", 1)
    engine, session_factory = await _queue_library(
        [(1, 1, [(0, "start"), (1, "a"), (2, "b"), (3, "c"), (4, "d"), (5, "e")])],
        # start/a and b/c are comparable at 34: phantoms. d/e is real work, e
        # needs 34 to match its parent.
        depths={"start": 34, "a": 34, "b": 34, "c": 34, "d": 34, "e": 22},
    )
    async with session_factory() as session:
        payload = await unanalyzed_fens(username="tester", color="both", time_class=None,
                                        min_depth=22, limit=1, session=session)
    assert payload["fens"] == ["e"]
    assert payload["fen_depths"] == {"e": 34}
    await engine.dispose()


@pytest.mark.usefixtures("symbolic_queue_fens")
@pytest.mark.asyncio
# The SQL exclusion of already-read pairs is an optimisation with a cap; the
# answer must not depend on it.
@pytest.mark.parametrize("sql_cap", [4000, 1, 0])
async def test_a_decision_repeated_across_games_counts_once_toward_the_walk(monkeypatch, sql_cap) -> None:
    monkeypatch.setattr(games_router, "_SEEN_PAIRS_IN_SQL", sql_cap)
    """Openings repeat. The same unfinished pair in the newest games filled the
    walk's target with copies of itself, so everything older went unseen."""

    monkeypatch.setattr(games_router, "_MIN_RECENT_DECISIONS", 2)
    monkeypatch.setattr(games_router, "_RECENT_DECISION_OVERFETCH", 1)
    monkeypatch.setattr(games_router, "_GAME_CHUNK_START", 1)
    engine, session_factory = await _queue_library(
        [
            (3, 3, [(0, "p"), (1, "c")]),
            (2, 2, [(0, "p"), (1, "c")]),
            (1, 1, [(0, "q"), (1, "d")]),
        ],
        depths={"p": 30, "c": 22, "q": 30, "d": 22},
    )
    async with session_factory() as session:
        payload = await unanalyzed_fens(username="tester", color="both", time_class=None,
                                        min_depth=22, limit=2, session=session)
    assert sorted(payload["fens"]) == ["c", "d"]
    await engine.dispose()


@pytest.mark.usefixtures("symbolic_queue_fens")
@pytest.mark.asyncio
async def test_excluded_positions_do_not_empty_the_queue(monkeypatch) -> None:
    """The crawler excludes the searches it timed out on. The pool used to be
    built without them and filtered afterwards, so once the newest pairs were
    all excluded a one-engine crawler (limit 5) got nothing for thirty hours
    while hundreds of pairs further back still needed work."""

    monkeypatch.setattr(games_router, "_MIN_RECENT_DECISIONS", 1)
    monkeypatch.setattr(games_router, "_RECENT_DECISION_OVERFETCH", 1)
    engine, session_factory = await _queue_library(
        [
            (2, 2, [(0, "p1"), (1, "stuck")]),
            (1, 1, [(0, "p2"), (1, "older")]),
        ],
        depths={"p1": 22, "p2": 30, "older": 22},
    )
    async with session_factory() as session:
        plain = await unanalyzed_fens(username="tester", color="both", time_class=None,
                                      min_depth=22, limit=1, session=session)
        assert plain["fens"] == ["stuck"]
        excluding = await unanalyzed_fens(
            username="tester", color="both", time_class=None, min_depth=22, limit=1,
            session=session, exclusions=AnalysisQueueExclusions(exclude_fens=["stuck"]),
        )
    assert excluding["fens"] == ["older"]
    assert excluding["fen_depths"] == {"older": 30}
    await engine.dispose()


@pytest.mark.usefixtures("symbolic_queue_fens")
@pytest.mark.asyncio
async def test_the_sitting_just_played_is_searched_before_the_rotation() -> None:
    # The Habits coach reads the newest analysed game, so a game just played
    # must not wait its era's turn behind an old endgame.
    get_shared_cache()._local.clear()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        now = datetime.now(UTC)
        session.add_all([
            build_game(1, "https://chess.com/game/1", "Italian Game", datetime(2024, 1, 1, tzinfo=UTC)),
            build_game(2, "https://chess.com/game/2", "Italian Game", now - timedelta(hours=1)),
        ])
        labels = ("old-parent", "old-child", "fresh-parent", "fresh-child")
        session.add_all(
            [Position(id=index, fen=label, total_games=1) for index, label in enumerate(labels, start=1)]
        )
        session.add_all([
            GamePosition(game_id=1, position_id=1, ply=62, move_uci="g8h7"),
            GamePosition(game_id=1, position_id=2, ply=63, move_uci="g1f2"),
            GamePosition(game_id=2, position_id=3, ply=20, move_uci="b8c6"),
            GamePosition(game_id=2, position_id=4, ply=21, move_uci="g1f3"),
        ])
        await session.commit()

        payload = await unanalyzed_fens(
            username="tester", color="both", time_class="rapid_blitz",
            min_depth=20, limit=2, session=session,
        )
        assert payload["fens"] == ["fresh-parent", "fresh-child"]
        assert payload["selected_decision_pairs_by_phase"]["fresh"] == 2

        # A game played a week ago is history: the rotation decides.
        await session.execute(
            Game.__table__.update().where(Game.id == 2).values(played_at=now - timedelta(days=7))
        )
        await session.commit()
        get_shared_cache()._local.clear()
        later = await unanalyzed_fens(
            username="tester", color="both", time_class="rapid_blitz",
            min_depth=20, limit=2, session=session,
        )
        assert "fresh" not in later["selected_decision_pairs_by_phase"]
    await engine.dispose()


@pytest.mark.usefixtures("symbolic_queue_fens")
@pytest.mark.asyncio
async def test_a_short_pool_is_not_walked_again_on_every_request(monkeypatch) -> None:
    # A nearly analysed library leaves every pool short of work; rebuilding on
    # each request walked the library for nothing (3-10s, every minute).
    get_shared_cache()._local.clear()
    monkeypatch.setattr(games_router, "_POOL_REFILL_FACTOR", 1000)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    walks: list[str] = []

    @event.listens_for(engine.sync_engine, "before_cursor_execute")
    def count_walks(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith("SELECT min(games.played_at)"):
            walks.append(statement)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add(build_game(1, "https://chess.com/game/1", "Italian Game", datetime(2024, 1, 1, tzinfo=UTC)))
        session.add_all([Position(id=1, fen="a-parent", total_games=1), Position(id=2, fen="a-child", total_games=1)])
        session.add_all([
            GamePosition(game_id=1, position_id=1, ply=40, move_uci="g8h7"),
            GamePosition(game_id=1, position_id=2, ply=41, move_uci="g1f2"),
        ])
        await session.commit()

        async def ask() -> dict:
            return await unanalyzed_fens(
                username="tester", color="both", time_class="rapid_blitz",
                min_depth=20, limit=2, session=session,
            )

        first = await ask()
        second = await ask()
        assert first["fens"] == second["fens"] == ["a-parent", "a-child"]
        assert len(walks) == 1, "a short pool was walked again inside its rest"

        # Once the rest is over, a short pool is walked again.
        for key in [key for key in get_shared_cache()._local if ":rebuilt:generation:" in key]:
            get_shared_cache()._remove_local(key)
        await ask()
        assert len(walks) == 2
    await engine.dispose()


@pytest.mark.asyncio
async def test_unstorable_positions_cannot_hide_the_work_behind_them(monkeypatch) -> None:
    # The newest unanalysed positions were a Chess960 game the evaluations
    # endpoint cannot store; one fixed read window of them told the crawler
    # the queue was empty all night.
    get_shared_cache()._local.clear()
    monkeypatch.setattr(games_router, "_is_storable_fen", lambda fen: not fen.startswith("960"))
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add_all([
            build_game(1, "https://chess.com/game/1", "Italian Game", datetime(2024, 1, 1, tzinfo=UTC)),
            build_game(2, "https://chess.com/game/2", "Chess960", datetime(2024, 2, 1, tzinfo=UTC)),
        ])
        session.add(Position(id=1, fen="real-work", total_games=1))
        # More frequent than the real work, so the recurrence fallback meets them first too.
        session.add_all([Position(id=index, fen=f"960-{index}", total_games=5) for index in range(2, 32)])
        session.add(GamePosition(game_id=1, position_id=1, ply=0))
        session.add_all([GamePosition(game_id=2, position_id=index, ply=index) for index in range(2, 32)])
        await session.commit()

        payload = await unanalyzed_fens(
            username="tester", color="both", time_class="rapid_blitz",
            min_depth=20, limit=1, session=session,
        )
        assert payload["fens"] == ["real-work"]
    await engine.dispose()


@pytest.mark.asyncio
async def test_chess960_games_are_left_out_of_the_queue_and_its_counts() -> None:
    # Their castling rights cannot be stored, so they could only ever be
    # "missing" and fill the fallback reads with positions nobody can search.
    get_shared_cache()._local.clear()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        standard = build_game(1, "https://chess.com/game/1", "Italian Game", datetime(2024, 1, 1, tzinfo=UTC))
        chess960 = build_game(2, "https://chess.com/game/2", "Chess960", datetime(2024, 2, 1, tzinfo=UTC))
        chess960.pgn = '[Event "Live Chess - Chess960"]\n[Variant "Chess960"]\n[SetUp "1"]\n\n1. e4 *'
        session.add_all([standard, chess960])
        session.add_all([
            Position(id=1, fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -", total_games=1),
            Position(id=2, fen="rkbrqnnb/pppppppp/8/8/8/8/PPPPPPPP/RKBRQNNB w KQkq -", total_games=1),
        ])
        session.add_all([
            GamePosition(game_id=1, position_id=1, ply=0),
            GamePosition(game_id=2, position_id=2, ply=0),
        ])
        await session.commit()
        payload = await unanalyzed_fens(
            username="tester", color="both", time_class="rapid_blitz",
            min_depth=20, limit=5, session=session,
        )
        assert payload["fens"] == ["rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"]
        assert payload["candidate_count"] == 1
    await engine.dispose()
