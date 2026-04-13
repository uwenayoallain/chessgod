from pathlib import Path
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
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
