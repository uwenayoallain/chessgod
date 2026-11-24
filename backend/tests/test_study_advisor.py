"""Tests for the Study Coach and Grandmaster Playbook curriculum."""

from __future__ import annotations

from datetime import UTC, datetime

import chess
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.services.study_advisor import _match_opening_playbook, build_study_guide
from app.services.study_courses import BUILTIN_COURSE_PRESETS
from app.services.study_curriculum import PLAYBOOKS


@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


def test_all_playbook_tabiya_fens_are_valid_and_match_color() -> None:
    """Every opening/strategy tabiya FEN must parse cleanly in python-chess."""
    assert len(PLAYBOOKS) >= 12
    for pb in PLAYBOOKS:
        assert pb.core_ideas, f"{pb.id} must have core_ideas"
        assert pb.courses, f"{pb.id} must have at least one recommended course"
        if pb.tabiya_fen:
            # 4-field FENs expand cleanly when given halfmove/fullmove counters.
            board = chess.Board(f"{pb.tabiya_fen} 0 1")
            assert board.is_valid(), f"Invalid tabiya_fen in {pb.id}: {pb.tabiya_fen}"
            if pb.category == "opening" and pb.color in ("white", "black"):
                expected_turn = chess.WHITE if pb.color == "white" else chess.BLACK
                assert (
                    board.turn == expected_turn
                ), f"{pb.id} color is {pb.color} but FEN turn is {'white' if board.turn else 'black'}"


def test_all_playbooks_reference_their_matching_course_presets() -> None:
    actual = {playbook.id: playbook.course_preset_id for playbook in PLAYBOOKS}
    assert actual == {
        "quiet_moves_planning": "middlegame_mastery_white",
        "blunder_prevention": "middlegame_mastery_white",
        "tactical_punishment": "middlegame_mastery_white",
        "defensive_resilience": "defense_endgame_mastery_white",
        "endgame_technique": "defense_endgame_mastery_white",
        "session_discipline": None,
        "italian_white": "italian_giuoco_white",
        "italian_black": "scotch_kings_gambit_black",
        "scotch_black": "scotch_kings_gambit_black",
        "kings_gambit_black": "scotch_kings_gambit_black",
        "qgd_vs_d4_black": "qgd_vs_d4_black",
        "london_white": "london_aggressive_white",
        "sicilian_white": "anti_sicilian_caro_white",
        "caro_kann_white": "anti_sicilian_caro_white",
        "french_white": "anti_sicilian_caro_white",
        "scandinavian_white": "anti_sicilian_caro_white",
        "pirc_modern_white": "anti_sicilian_caro_white",
        "ruy_lopez_e4_e5": "italian_giuoco_white",
    }
    assert all(preset_id is None or preset_id in BUILTIN_COURSE_PRESETS for preset_id in actual.values())


def test_match_opening_playbook_distinguishes_color_and_structure() -> None:
    assert _match_opening_playbook("black", "C45", "Scotch Game 3...exd4").id == "scotch_black"
    assert _match_opening_playbook("black", "D02", "Queen's Pawn Opening Zukertort Chigorin").id == "qgd_vs_d4_black"
    assert _match_opening_playbook("white", "D02", "London System").id == "london_white"
    assert _match_opening_playbook("white", "B13", "Caro Kann Defense Exchange Variation").id == "caro_kann_white"
    assert _match_opening_playbook("white", "B30", "Sicilian Defense Old Sicilian").id == "sicilian_white"
    assert _match_opening_playbook("white", "C50", "Italian Game").id == "italian_white"
    assert _match_opening_playbook("black", "C50", "Giuoco Piano Game").id == "italian_black"
    assert _match_opening_playbook("white", "B01", "Scandinavian Defense").id == "scandinavian_white"


@pytest.mark.asyncio
async def test_build_study_guide_surfaces_real_opening_leaks(db_session) -> None:
    """A player losing heavily in the Scotch and Chigorin gets those exact playbooks recommended."""
    now = datetime.now(UTC)
    games: list[Game] = []
    # 12 Black Scotch games: 2 wins, 10 losses -> 83.3% loss rate
    for i in range(12):
        res = "win" if i < 2 else "loss"
        games.append(
            Game(
                chesscom_game_url=f"https://chess.com/game/scotch-{i}",
                username="tester",
                white_username=f"opp-{i}",
                black_username="tester",
                user_color="black",
                result="0-1" if res == "win" else "1-0",
                user_result=res,
                time_class="rapid",
                white_rating=1700,
                black_rating=1700,
                pgn="1. e4 e5 2. Nf3 Nc6 3. d4 exd4 *",
                eco="C45",
                opening_name="Scotch Game 3...exd4 4.Nxd4 Nxd4 5.Qxd4",
                played_at=now,
            )
        )
    # 12 White Italian games: 9 wins, 3 losses -> 25% loss rate (not a leak)
    for i in range(12):
        res = "win" if i < 9 else "loss"
        games.append(
            Game(
                chesscom_game_url=f"https://chess.com/game/italian-{i}",
                username="tester",
                white_username="tester",
                black_username=f"opp2-{i}",
                user_color="white",
                result="1-0" if res == "win" else "0-1",
                user_result=res,
                time_class="rapid",
                white_rating=1720,
                black_rating=1700,
                pgn="1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *",
                eco="C50",
                opening_name="Giuoco Piano Game",
                played_at=now,
            )
        )
    db_session.add_all(games)
    await db_session.commit()

    guide = await build_study_guide(
        db_session,
        username="tester",
        time_class="rapid_blitz",
        min_user_rating=1000,
    )

    rec_ids = [item["playbook_id"] for item in guide["recommended"]]
    assert "scotch_black" in rec_ids
    scotch = next(item["playbook"] for item in guide["recommended"] if item["playbook_id"] == "scotch_black")
    assert scotch["course_preset_id"] == "scotch_kings_gambit_black"
    assert "italian_white" not in rec_ids  # Winning 75%, low volume -> not flagged as leak
    assert guide["player_snapshot"]["latest_rating"] in (1700, 1720)
    assert len(guide["catalog"]) == len(PLAYBOOKS)
    assert {item["id"]: item["course_preset_id"] for item in guide["catalog"]} == {
        playbook.id: playbook.course_preset_id for playbook in PLAYBOOKS
    }


@pytest.mark.asyncio
async def test_study_guide_shares_the_points_and_habits_cache(db_session, monkeypatch) -> None:
    """A cold guide publishes the entries its pages read, and a second guide builds nothing."""
    from app.services import study_advisor
    from app.services.cache import get_shared_cache

    now = datetime.now(UTC)
    db_session.add_all([
        Game(
            chesscom_game_url=f"https://chess.com/game/cache-{i}",
            username="cached",
            white_username="cached",
            black_username=f"opp-{i}",
            user_color="white",
            result="0-1",
            user_result="loss",
            time_class="blitz",
            white_rating=1500,
            black_rating=1500,
            pgn="1. d4 d5 2. Bf4 *",
            eco="D02",
            opening_name="London System",
            played_at=now,
        )
        for i in range(12)
    ])
    await db_session.commit()

    cold = await build_study_guide(db_session, username="cached", time_class="rapid_blitz", min_user_rating=1000)

    cache = get_shared_cache()
    points = await cache.get_json(await cache.versioned_key("improvement:losses:cached:v2:both:rapid_blitz:1000"))
    habits = await cache.get_json(await cache.versioned_key("improvement:habits:cached:1000"))
    assert points is not None and points["username"] == "cached"
    assert habits is not None and habits["username"] == "cached"
    assert await cache.get_json("improvement:losseslast:cached:v2:both:rapid_blitz:1000") == points
    assert await cache.get_json("training:habitslast:cached:1000") == habits

    async def no_build(*_args, **_kwargs):
        raise AssertionError("a fresh cache entry must be reused")

    monkeypatch.setattr(study_advisor, "build_points_lost", no_build)
    monkeypatch.setattr(study_advisor, "build_habits", no_build)
    warm = await build_study_guide(db_session, username="cached", time_class="rapid_blitz", min_user_rating=1000)
    assert warm == cold
    assert "london_white" in [item["playbook_id"] for item in warm["recommended"]]

    # New evidence bumps the generation: the next guide rebuilds instead of reusing.
    await cache.delete_prefix("improvement:losses:cached:", versioned_only=True)
    with pytest.raises(AssertionError, match="fresh cache entry"):
        await build_study_guide(db_session, username="cached", time_class="rapid_blitz", min_user_rating=1000)
