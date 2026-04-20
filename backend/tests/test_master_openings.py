from pathlib import Path
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.external_sync_state import ExternalSyncState
from app.models.position import Position
from app.models.position_move import PositionMove
from app.services.master_openings import seed_opening_book, sync_stale_master_data


class FakeExplorerClient:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def get_master_stats(self, fen: str) -> dict:
        self.calls.append(fen)
        return {
            "white": 12,
            "draws": 3,
            "black": 5,
            "opening": {"eco": "C20", "name": "King Pawn Game"},
            "moves": [
                {
                    "san": "e4",
                    "uci": "e2e4",
                    "white": 12,
                    "draws": 3,
                    "black": 5,
                }
            ],
        }


class UnauthorizedExplorerClient:
    def __init__(self) -> None:
        self.calls = 0

    async def get_master_stats(self, fen: str) -> dict:
        self.calls += 1
        request = httpx.Request("GET", "https://explorer.lichess.ovh/masters")
        response = httpx.Response(status_code=401, request=request)
        raise httpx.HTTPStatusError("Unauthorized", request=request, response=response)


class RateLimitedExplorerClient:
    def __init__(self) -> None:
        self.calls = 0

    async def get_master_stats(self, fen: str) -> dict:
        self.calls += 1
        request = httpx.Request("GET", "https://explorer.lichess.ovh/masters")
        response = httpx.Response(status_code=429, headers={"Retry-After": "120"}, request=request)
        raise httpx.HTTPStatusError("Rate limited", request=request, response=response)


SYNC_PROVIDER = "lichess_opening_explorer"


@pytest.mark.asyncio
async def test_seed_opening_book_populates_positions_and_moves(tmp_path: Path) -> None:
    data_dir = tmp_path / "openings"
    data_dir.mkdir()
    (data_dir / "c.tsv").write_text(
        "eco\tname\tpgn\n"
        "C20\tKing Pawn Game\t1. e4 e5 2. Nf3\n",
        encoding="utf-8",
    )

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        seeded = await seed_opening_book(session, data_dir=data_dir)
        await session.commit()

        positions = list((await session.execute(select(Position).order_by(Position.id))).scalars().all())
        moves = list(
            (await session.execute(select(PositionMove).order_by(PositionMove.id))).scalars().all()
        )

        assert seeded == 1
        assert len(positions) == 4
        assert len(moves) == 3
        assert positions[1].master_opening_name == "King Pawn Game"
        assert positions[1].master_eco == "C20"
        assert moves[0].move_san == "e4"
        assert moves[0].master_game_count == 0
        assert moves[1].move_san == "e5"
        assert moves[2].move_san == "Nf3"

    await engine.dispose()


@pytest.mark.asyncio
async def test_seed_opening_book_is_idempotent(tmp_path: Path) -> None:
    data_dir = tmp_path / "openings"
    data_dir.mkdir()
    (data_dir / "b.tsv").write_text(
        "eco\tname\tpgn\n"
        "B00\tBarnes Opening\t1. f3\n",
        encoding="utf-8",
    )

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        await seed_opening_book(session, data_dir=data_dir)
        await session.commit()
        await seed_opening_book(session, data_dir=data_dir)
        await session.commit()

        position_count = await session.scalar(select(func.count()).select_from(Position))
        move_count = await session.scalar(select(func.count()).select_from(PositionMove))

        assert position_count == 2
        assert move_count == 1

    await engine.dispose()


@pytest.mark.asyncio
async def test_sync_stale_master_data_updates_seeded_positions() -> None:
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
                Position(id=2, fen="after-e4", total_games=0, white_wins=0, draws=0, black_wins=0),
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

        client = FakeExplorerClient()
        refreshed = await sync_stale_master_data(session, client)
        await session.commit()

        position = await session.scalar(select(Position).where(Position.id == 1))
        move = await session.scalar(select(PositionMove).where(PositionMove.from_position_id == 1))

        assert refreshed == 1
        assert client.calls == ["start"]
        assert position is not None and position.master_total == 20
        assert position.master_fetched_at is not None
        assert move is not None and move.master_game_count == 20

    await engine.dispose()


@pytest.mark.asyncio
async def test_sync_stale_master_data_skips_fresh_positions() -> None:
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
                    master_total=20,
                    master_white=12,
                    master_draws=3,
                    master_black=5,
                    master_fetched_at=datetime.now(UTC) - timedelta(days=1),
                ),
                Position(id=2, fen="after-e4", total_games=0, white_wins=0, draws=0, black_wins=0),
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
                master_game_count=20,
                master_white_wins=12,
                master_draws=3,
                master_black_wins=5,
                master_fetched_at=datetime.now(UTC) - timedelta(days=1),
            )
        )
        await session.commit()

        client = FakeExplorerClient()
        refreshed = await sync_stale_master_data(session, client)

        assert refreshed == 0
        assert client.calls == []

    await engine.dispose()


@pytest.mark.asyncio
async def test_sync_stale_master_data_stops_gracefully_on_unauthorized_response() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                Position(id=1, fen="start", total_games=0, white_wins=0, draws=0, black_wins=0),
                Position(id=2, fen="after-e4", total_games=0, white_wins=0, draws=0, black_wins=0),
                Position(id=3, fen="after-d4", total_games=0, white_wins=0, draws=0, black_wins=0),
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
                    game_count=0,
                    white_wins=0,
                    draws=0,
                    black_wins=0,
                    master_game_count=0,
                    master_white_wins=0,
                    master_draws=0,
                    master_black_wins=0,
                ),
                PositionMove(
                    from_position_id=3,
                    to_position_id=2,
                    move_san="d4",
                    move_uci="d2d4",
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
                ),
            ]
        )
        await session.commit()

        client = UnauthorizedExplorerClient()
        refreshed = await sync_stale_master_data(session, client)

        assert refreshed == 0
        assert client.calls == 1

    await engine.dispose()


@pytest.mark.asyncio
async def test_sync_stale_master_data_respects_min_position_games_threshold() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                Position(id=1, fen="seeded", total_games=0, white_wins=0, draws=0, black_wins=0),
                Position(id=2, fen="after-e4", total_games=0, white_wins=0, draws=0, black_wins=0),
                Position(id=3, fen="user-pos", total_games=3, white_wins=2, draws=0, black_wins=1),
                Position(id=4, fen="after-d4", total_games=0, white_wins=0, draws=0, black_wins=0),
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
                    game_count=0,
                    white_wins=0,
                    draws=0,
                    black_wins=0,
                    master_game_count=0,
                    master_white_wins=0,
                    master_draws=0,
                    master_black_wins=0,
                ),
                PositionMove(
                    from_position_id=3,
                    to_position_id=4,
                    move_san="d4",
                    move_uci="d2d4",
                    move_number=1,
                    is_white_move=True,
                    game_count=3,
                    white_wins=2,
                    draws=0,
                    black_wins=1,
                    master_game_count=0,
                    master_white_wins=0,
                    master_draws=0,
                    master_black_wins=0,
                ),
            ]
        )
        await session.commit()

        client = FakeExplorerClient()
        refreshed = await sync_stale_master_data(
            session,
            client,
            min_position_games=1,
        )

        assert refreshed == 1
        assert client.calls == ["user-pos"]

    await engine.dispose()


@pytest.mark.asyncio
async def test_sync_stale_master_data_respects_max_positions_per_run() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                Position(id=1, fen="pos-a", total_games=7, white_wins=4, draws=1, black_wins=2),
                Position(id=2, fen="after-a", total_games=0, white_wins=0, draws=0, black_wins=0),
                Position(id=3, fen="pos-b", total_games=6, white_wins=3, draws=1, black_wins=2),
                Position(id=4, fen="after-b", total_games=0, white_wins=0, draws=0, black_wins=0),
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
                    game_count=7,
                    white_wins=4,
                    draws=1,
                    black_wins=2,
                    master_game_count=0,
                    master_white_wins=0,
                    master_draws=0,
                    master_black_wins=0,
                ),
                PositionMove(
                    from_position_id=3,
                    to_position_id=4,
                    move_san="e4",
                    move_uci="e2e4",
                    move_number=1,
                    is_white_move=True,
                    game_count=6,
                    white_wins=3,
                    draws=1,
                    black_wins=2,
                    master_game_count=0,
                    master_white_wins=0,
                    master_draws=0,
                    master_black_wins=0,
                ),
            ]
        )
        await session.commit()

        client = FakeExplorerClient()
        refreshed = await sync_stale_master_data(
            session,
            client,
            max_positions=1,
        )

        assert refreshed == 1
        assert len(client.calls) == 1

    await engine.dispose()


@pytest.mark.asyncio
async def test_sync_stale_master_data_stops_gracefully_on_rate_limit() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                Position(id=1, fen="pos-a", total_games=4, white_wins=2, draws=1, black_wins=1),
                Position(id=2, fen="after-a", total_games=0, white_wins=0, draws=0, black_wins=0),
                Position(id=3, fen="pos-b", total_games=3, white_wins=1, draws=1, black_wins=1),
                Position(id=4, fen="after-b", total_games=0, white_wins=0, draws=0, black_wins=0),
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
                    game_count=4,
                    white_wins=2,
                    draws=1,
                    black_wins=1,
                    master_game_count=0,
                    master_white_wins=0,
                    master_draws=0,
                    master_black_wins=0,
                ),
                PositionMove(
                    from_position_id=3,
                    to_position_id=4,
                    move_san="d4",
                    move_uci="d2d4",
                    move_number=1,
                    is_white_move=True,
                    game_count=3,
                    white_wins=1,
                    draws=1,
                    black_wins=1,
                    master_game_count=0,
                    master_white_wins=0,
                    master_draws=0,
                    master_black_wins=0,
                ),
            ]
        )
        await session.commit()

        client = RateLimitedExplorerClient()
        refreshed = await sync_stale_master_data(session, client)

        assert refreshed == 0
        assert client.calls == 1

    await engine.dispose()


@pytest.mark.asyncio
async def test_sync_stale_master_data_persists_cooldown_after_unauthorized() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                Position(id=1, fen="start", total_games=3, white_wins=2, draws=0, black_wins=1),
                Position(id=2, fen="after-e4", total_games=0, white_wins=0, draws=0, black_wins=0),
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
                game_count=3,
                white_wins=2,
                draws=0,
                black_wins=1,
                master_game_count=0,
                master_white_wins=0,
                master_draws=0,
                master_black_wins=0,
            )
        )
        await session.commit()

        unauthorized_client = UnauthorizedExplorerClient()
        refreshed = await sync_stale_master_data(session, unauthorized_client)
        await session.commit()

        state = await session.scalar(
            select(ExternalSyncState).where(ExternalSyncState.provider == SYNC_PROVIDER)
        )
        assert refreshed == 0
        assert unauthorized_client.calls == 1
        assert state is not None
        assert state.cooldown_until is not None
        assert state.last_status_code == 401

        healthy_client = FakeExplorerClient()
        refreshed = await sync_stale_master_data(session, healthy_client)

        assert refreshed == 0
        assert healthy_client.calls == []

    await engine.dispose()


@pytest.mark.asyncio
async def test_sync_stale_master_data_uses_expired_cooldown_state() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        session.add_all(
            [
                Position(id=1, fen="start", total_games=3, white_wins=2, draws=0, black_wins=1),
                Position(id=2, fen="after-e4", total_games=0, white_wins=0, draws=0, black_wins=0),
                ExternalSyncState(
                    provider=SYNC_PROVIDER,
                    cooldown_until=datetime.now(UTC) - timedelta(hours=1),
                    last_status_code=401,
                    last_error="authorization",
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
                game_count=3,
                white_wins=2,
                draws=0,
                black_wins=1,
                master_game_count=0,
                master_white_wins=0,
                master_draws=0,
                master_black_wins=0,
            )
        )
        await session.commit()

        healthy_client = FakeExplorerClient()
        refreshed = await sync_stale_master_data(session, healthy_client)

        assert refreshed == 1
        assert healthy_client.calls == ["start"]

    await engine.dispose()
