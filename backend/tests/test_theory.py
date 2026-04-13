from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.position import Position
from app.models.position_move import PositionMove
from app.routers.theory import theory_compare, theory_deviations
from app.services.pgn_parser import parse_game_pgn
from app.services.theory import (
    LichessExplorerClient,
    build_deviation,
    build_training_line_from_parsed_game,
    classify_deviation_severity,
    get_or_fetch_master_data,
)


class NeverFetchClient:
    async def get_master_stats(self, fen: str) -> dict:
        raise AssertionError(f"unexpected live fetch for {fen}")


def test_classify_deviation_severity_uses_plan_thresholds() -> None:
    assert classify_deviation_severity(0.50, 0.53) == "minor"
    assert classify_deviation_severity(0.42, 0.53) == "moderate"
    assert classify_deviation_severity(0.31, 0.53) == "major"


def test_build_deviation_returns_none_when_top_move_matches_master() -> None:
    user_moves = [
        {"san": "e4", "game_count": 24, "move_number": 1, "win_rate": 0.54},
        {"san": "d4", "game_count": 12, "move_number": 1, "win_rate": 0.51},
    ]
    master_moves = [
        {"san": "e4", "game_count": 15000, "win_rate": 0.55},
        {"san": "d4", "game_count": 12000, "win_rate": 0.54},
    ]

    assert build_deviation(
        fen="startpos",
        user_moves=user_moves,
        master_moves=master_moves,
        eco="C20",
        opening_name="King Pawn Game",
    ) is None


def test_build_deviation_returns_deviation_when_top_move_differs_from_master() -> None:
    user_moves = [
        {"san": "Bg5", "game_count": 45, "move_number": 6, "win_rate": 0.48},
        {"san": "Be2", "game_count": 10, "move_number": 6, "win_rate": 0.51},
    ]
    master_moves = [
        {"san": "Be2", "game_count": 12000, "win_rate": 0.55},
        {"san": "h3", "game_count": 8000, "win_rate": 0.53},
        {"san": "f4", "game_count": 6000, "win_rate": 0.52},
    ]

    deviation = build_deviation(
        fen="fen-string",
        user_moves=user_moves,
        master_moves=master_moves,
        eco="B90",
        opening_name="Sicilian Najdorf",
    )

    assert deviation == {
        "fen": "fen-string",
        "move_number": 6,
        "user_top_move": {"san": "Bg5", "game_count": 45, "win_rate": 0.48},
        "master_top_move": {"san": "Be2", "game_count": 12000, "win_rate": 0.55},
        "eco": "B90",
        "opening_name": "Sicilian Najdorf",
        "severity": "moderate",
    }


@pytest.mark.asyncio
async def test_build_training_line_uses_cached_master_moves() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                Position(
                    id=1,
                    fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
                    total_games=1,
                    white_wins=1,
                    draws=0,
                    black_wins=0,
                    master_total=100,
                    master_white=55,
                    master_draws=20,
                    master_black=25,
                    master_fetched_at=datetime.now(UTC),
                ),
                Position(
                    id=2,
                    fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -",
                    total_games=1,
                    white_wins=1,
                    draws=0,
                    black_wins=0,
                    master_total=90,
                    master_white=45,
                    master_draws=20,
                    master_black=25,
                    master_fetched_at=datetime.now(UTC),
                ),
            ]
        )
        session.add_all(
            [
                PositionMove(
                    from_position_id=1,
                    to_position_id=2,
                    move_san="e4",
                    move_uci="e2e4",
                    move_number=1,
                    is_white_move=True,
                    game_count=1,
                    white_wins=1,
                    draws=0,
                    black_wins=0,
                    master_game_count=60,
                    master_white_wins=35,
                    master_draws=10,
                    master_black_wins=15,
                    master_fetched_at=datetime.now(UTC),
                ),
                PositionMove(
                    from_position_id=2,
                    to_position_id=1,
                    move_san="e5",
                    move_uci="e7e5",
                    move_number=2,
                    is_white_move=False,
                    game_count=1,
                    white_wins=1,
                    draws=0,
                    black_wins=0,
                    master_game_count=55,
                    master_white_wins=25,
                    master_draws=15,
                    master_black_wins=15,
                    master_fetched_at=datetime.now(UTC),
                ),
            ]
        )
        await session.commit()

        parsed = parse_game_pgn(
            '[Event "Test"]\n[Site "?"]\n[Date "2024.01.01"]\n[Round "-"]\n[White "tester"]\n[Black "opponent"]\n[Result "1-0"]\n\n1. e4 e5 1-0'
        )
        line = await build_training_line_from_parsed_game(
            session=session,
            parsed_game=parsed,
        )

        assert [move["san"] for move in line] == ["e4", "e5"]

    await engine.dispose()


@pytest.mark.asyncio
async def test_get_or_fetch_master_data_uses_seeded_moves_without_live_fetch() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        position = Position(
            id=1,
            fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
            total_games=0,
            white_wins=0,
            draws=0,
            black_wins=0,
            master_eco="C20",
            master_opening_name="King Pawn Game",
            master_total=None,
            master_fetched_at=None,
        )
        move = PositionMove(
            from_position_id=1,
            to_position_id=2,
            move_san="e4",
            move_uci="e2e4",
            move_number=1,
            is_white_move=True,
            game_count=0,
            white_wins=0,
            draws=0,
            black_wins=0,
            master_game_count=0,
            master_white_wins=0,
            master_draws=0,
            master_black_wins=0,
            master_fetched_at=None,
        )
        session.add(position)
        session.add(
            Position(
                id=2,
                fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -",
                total_games=0,
                white_wins=0,
                draws=0,
                black_wins=0,
            )
        )
        session.add(move)
        await session.commit()

        master_data = await get_or_fetch_master_data(
            session=session,
            client=NeverFetchClient(),
            position=position,
            moves=[move],
        )

        assert master_data["opening"] == {"eco": "C20", "name": "King Pawn Game"}
        assert master_data["moves"] == [
            {
                "san": "e4",
                "uci": "e2e4",
                "white": 0,
                "draws": 0,
                "black": 0,
            }
        ]

    await engine.dispose()


@pytest.mark.asyncio
async def test_build_training_line_uses_seeded_master_moves_without_live_fetch() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                Position(
                    id=1,
                    fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
                    total_games=0,
                    white_wins=0,
                    draws=0,
                    black_wins=0,
                    master_eco="C20",
                    master_opening_name="King Pawn Game",
                ),
                Position(
                    id=2,
                    fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -",
                    total_games=0,
                    white_wins=0,
                    draws=0,
                    black_wins=0,
                    master_eco="C20",
                    master_opening_name="King Pawn Game",
                ),
            ]
        )
        session.add(
            PositionMove(
                from_position_id=1,
                to_position_id=2,
                move_san="e4",
                move_uci="e2e4",
                move_number=1,
                is_white_move=True,
                game_count=0,
                white_wins=0,
                draws=0,
                black_wins=0,
                master_game_count=0,
                master_white_wins=0,
                master_draws=0,
                master_black_wins=0,
            )
        )
        await session.commit()

        parsed = parse_game_pgn(
            '[Event "Test"]\n[Site "?"]\n[Date "2024.01.01"]\n[Round "-"]\n[White "tester"]\n[Black "opponent"]\n[Result "1-0"]\n\n1. e4 1-0'
        )
        line = await build_training_line_from_parsed_game(
            session=session,
            parsed_game=parsed,
        )

        assert [move["san"] for move in line] == ["e4"]

    await engine.dispose()


@pytest.mark.asyncio
async def test_theory_compare_reports_seeded_state_for_local_book_data() -> None:
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
                    total_games=0,
                    white_wins=0,
                    draws=0,
                    black_wins=0,
                    master_eco="C20",
                    master_opening_name="King Pawn Game",
                ),
                Position(
                    id=2,
                    fen="after-e4",
                    total_games=0,
                    white_wins=0,
                    draws=0,
                    black_wins=0,
                ),
            ]
        )
        session.add(
            PositionMove(
                from_position_id=1,
                to_position_id=2,
                move_san="e4",
                move_uci="e2e4",
                move_number=1,
                is_white_move=True,
                game_count=0,
                white_wins=0,
                draws=0,
                black_wins=0,
                master_game_count=0,
                master_white_wins=0,
                master_draws=0,
                master_black_wins=0,
            )
        )
        await session.commit()

        response = await theory_compare(fen="start", session=session)

        assert response.master_data_state == "seeded"
        assert [move.san for move in response.master_moves] == ["e4"]

    await engine.dispose()


@pytest.mark.asyncio
async def test_theory_deviations_uses_seeded_positions_to_find_non_book_top_moves() -> None:
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
                    total_games=12,
                    white_wins=7,
                    draws=2,
                    black_wins=3,
                    master_eco="C20",
                    master_opening_name="King Pawn Game",
                ),
                Position(id=2, fen="after-e4", total_games=3, white_wins=2, draws=1, black_wins=0),
                Position(id=3, fen="after-d4", total_games=9, white_wins=4, draws=2, black_wins=3),
            ]
        )
        session.add_all(
            [
                PositionMove(
                    from_position_id=1,
                    to_position_id=2,
                    move_san="e4",
                    move_uci="e2e4",
                    move_number=1,
                    is_white_move=True,
                    game_count=3,
                    white_wins=2,
                    draws=1,
                    black_wins=0,
                    master_game_count=0,
                    master_white_wins=0,
                    master_draws=0,
                    master_black_wins=0,
                ),
                PositionMove(
                    from_position_id=1,
                    to_position_id=3,
                    move_san="d4",
                    move_uci="d2d4",
                    move_number=1,
                    is_white_move=True,
                    game_count=9,
                    white_wins=4,
                    draws=2,
                    black_wins=3,
                ),
            ]
        )
        await session.commit()

        deviations = await theory_deviations(color="white", min_games=5, session=session)

        assert len(deviations) == 1
        assert deviations[0].user_top_move.san == "d4"
        assert deviations[0].master_top_move.san == "e4"
        assert deviations[0].opening_name == "King Pawn Game"

    await engine.dispose()


@pytest.mark.asyncio
async def test_theory_deviations_accepts_seeded_book_top_move() -> None:
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
                    total_games=12,
                    white_wins=7,
                    draws=2,
                    black_wins=3,
                    master_eco="C20",
                    master_opening_name="King Pawn Game",
                ),
                Position(id=2, fen="after-e4", total_games=9, white_wins=5, draws=2, black_wins=2),
                Position(id=3, fen="after-d4", total_games=3, white_wins=2, draws=1, black_wins=0),
            ]
        )
        session.add_all(
            [
                PositionMove(
                    from_position_id=1,
                    to_position_id=2,
                    move_san="e4",
                    move_uci="e2e4",
                    move_number=1,
                    is_white_move=True,
                    game_count=9,
                    white_wins=5,
                    draws=2,
                    black_wins=2,
                    master_game_count=0,
                    master_white_wins=0,
                    master_draws=0,
                    master_black_wins=0,
                ),
                PositionMove(
                    from_position_id=1,
                    to_position_id=3,
                    move_san="d4",
                    move_uci="d2d4",
                    move_number=1,
                    is_white_move=True,
                    game_count=3,
                    white_wins=2,
                    draws=1,
                    black_wins=0,
                ),
            ]
        )
        await session.commit()

        deviations = await theory_deviations(color="white", min_games=5, session=session)

        assert deviations == []

    await engine.dispose()
