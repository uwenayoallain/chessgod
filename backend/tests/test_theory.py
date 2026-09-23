from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_move import PositionMove
from app.routers.theory import (
    find_representative_deviation_games,
    theory_compare,
    theory_deviations,
)
from app.services.pgn_parser import parse_game_pgn
from app.services.theory import (
    LichessExplorerClient,
    build_deviation,
    cache_master_stats,
    build_training_line_from_parsed_game,
    classify_deviation_severity,
    get_or_fetch_master_data,
)


class NeverFetchClient:
    async def get_master_stats(self, fen: str) -> dict:
        raise AssertionError(f"unexpected live fetch for {fen}")


@pytest.mark.asyncio
async def test_representative_games_fetch_only_latest_rows_without_pgn() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add_all([Position(id=1, fen="after-d4"), Position(id=2, fen="after-e4")])
        for game_id in range(1, 31):
            session.add(Game(
                id=game_id,
                chesscom_game_url=f"https://chess.com/game/{game_id}",
                username="tester", white_username="tester", black_username="opponent",
                user_color="white", result="1-0", user_result="win", time_class="rapid",
                pgn="large unused PGN" * 100,
                # Equal timestamps must still select the highest game ID.
                played_at=datetime(2024, 1, 1, tzinfo=UTC),
            ))
            session.add(GamePosition(
                game_id=game_id, position_id=1 if game_id <= 20 else 2,
                ply=1, move_uci="d2d4" if game_id <= 20 else "e2e4",
            ))
        await session.commit()

        class BoundedSession:
            async def execute(self, statement):
                result = (await session.execute(statement)).freeze()
                assert len(result().all()) == 2, "only one row per target should leave the database"
                assert "games.pgn" not in str(statement)
                return result()

        d4 = PositionMove(to_position_id=1, move_number=1, move_uci="d2d4", move_san="d4")
        e4 = PositionMove(to_position_id=2, move_number=1, move_uci="e2e4", move_san="e4")
        rows = await find_representative_deviation_games(BoundedSession(), [
            ([d4], {"uci": "d2d4"}),
            ([e4], {"uci": "e2e4"}),
            ([d4], {"uci": "d2d4"}),
            ([], {"uci": "a2a3"}),
        ])
        assert [row.get("representative_game_id") for row in rows] == [20, 30, 20, None]
        assert rows[0]["representative_post_fen"] == "after-d4"
        assert rows[0]["representative_played_at"] == datetime(2024, 1, 1, tzinfo=UTC)
    await engine.dispose()


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
async def test_theory_deviations_include_representative_mistake_game_context() -> None:
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
        session.add(
            Game(
                id=42,
                chesscom_game_url="https://chess.com/game/42",
                chesscom_game_id="42",
                username="tester",
                white_username="tester",
                black_username="opponent",
                user_color="white",
                result="0-1",
                user_result="loss",
                time_class="rapid",
                time_control="600",
                white_rating=1200,
                black_rating=1250,
                pgn='[Event "Test"]\n[Site "?"]\n[Date "2024.01.01"]\n[Round "-"]\n[White "tester"]\n[Black "opponent"]\n[Result "0-1"]\n\n1. d4 0-1',
                eco="C20",
                opening_name="King Pawn Game",
                played_at=datetime(2024, 1, 3, tzinfo=UTC),
                num_moves=1,
            )
        )
        session.add_all(
            [
                GamePosition(game_id=42, position_id=1, ply=0, move_san=None, move_uci=None),
                GamePosition(game_id=42, position_id=3, ply=1, move_san="d4", move_uci="d2d4"),
            ]
        )
        await session.commit()

        deviations = await theory_deviations(color="white", min_games=5, session=session)

        assert len(deviations) == 1
        deviation = deviations[0]
        assert deviation.representative_game_id == 42
        assert deviation.representative_game_ply == 1
        assert deviation.representative_post_fen == "after-d4"
        assert deviation.representative_user_result == "loss"
        assert deviation.representative_played_at == datetime(2024, 1, 3, tzinfo=UTC)

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


@pytest.mark.asyncio
async def test_a_position_with_no_named_opening_is_cached_rather_than_crashing() -> None:
    """Lichess sends `"opening": null` once a line leaves the named openings.

    A default only applies to a *missing* key, so `.get("opening", {})` returned
    None here and the whole maintenance run died on the first such position --
    invisible for as long as the explorer answered 401 and nothing reached this
    code at all.
    """
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        position = Position(id=1, fen="some-deep-position")
        move = PositionMove(
            id=1, from_position_id=1, to_position_id=1,
            move_san="Nf3", move_uci="g1f3", move_number=5, is_white_move=True,
        )
        session.add_all([position, move])
        await session.flush()

        await cache_master_stats(session, position, [move], {
            "white": 10, "draws": 5, "black": 3,
            "opening": None,
            "moves": [{"uci": "g1f3", "san": "Nf3", "white": 6, "draws": 3, "black": 1}],
        })

        assert position.master_total == 18
        assert position.master_eco is None
        assert position.master_opening_name is None
        # The rest of the payload must still be cached: a missing name is not a
        # reason to discard the master statistics the deviation surface needs.
        assert move.master_game_count == 10


@pytest.mark.asyncio
async def test_a_named_opening_is_still_recorded() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        position = Position(id=1, fen="start")
        session.add(position)
        await session.flush()

        await cache_master_stats(session, position, [], {
            "white": 1, "draws": 1, "black": 1,
            "opening": {"eco": "B00", "name": "King's Pawn Game"},
            "moves": [],
        })

        assert position.master_eco == "B00"
        assert position.master_opening_name == "King's Pawn Game"
