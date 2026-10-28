from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.opening_family import OpeningFamily
from app.services.opening_families import (
    compute_root_fen,
    parse_family_segments,
    seed_opening_families,
)


def write_opening_file(data_dir: Path, rows: list[tuple[str, str, str]]) -> None:
    data_dir.mkdir(parents=True)
    for name in ("a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv"):
        (data_dir / name).write_text("eco\tname\tpgn\n", encoding="utf-8")

    body = "\n".join(f"{eco}\t{name}\t{pgn}" for eco, name, pgn in rows)
    (data_dir / "c.tsv").write_text(f"eco\tname\tpgn\n{body}\n", encoding="utf-8")


def test_parse_family_segments_splits_family_and_variations() -> None:
    assert parse_family_segments("Italian Game") == ["Italian Game"]
    assert parse_family_segments("Italian Game: Giuoco Piano") == ["Italian Game", "Giuoco Piano"]
    assert parse_family_segments("Italian Game: Giuoco Piano, Main Line") == [
        "Italian Game",
        "Giuoco Piano",
        "Main Line",
    ]
    assert parse_family_segments("Opening: With: Extra, Branch") == ["Opening", "With: Extra", "Branch"]


def test_compute_root_fen_replays_pgn_line() -> None:
    assert compute_root_fen("1. e4 e5 2. Nf3 Nc6") == "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -"


@pytest.mark.asyncio
async def test_seed_opening_families_is_idempotent_and_marks_main_lines(tmp_path: Path) -> None:
    data_dir = tmp_path / "openings"
    write_opening_file(
        data_dir,
        [
            ("C50", "Italian Game", "1. e4 e5 2. Nf3 Nc6 3. Bc4"),
            ("C53", "Italian Game: Giuoco Piano", "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5"),
            ("C54", "Italian Game: Giuoco Piano, Main Line", "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3"),
            ("C55", "Italian Game: Two Knights Defense", "1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6"),
        ],
    )
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        first_count = await seed_opening_families(session, data_dir=data_dir)
        await session.commit()
        second_count = await seed_opening_families(session, data_dir=data_dir)
        await session.commit()

        row_count = await session.scalar(select(func.count()).select_from(OpeningFamily))
        main_line = await session.scalar(
            select(OpeningFamily).where(OpeningFamily.full_name == "Italian Game: Giuoco Piano, Main Line")
        )
        fallback_main = await session.scalar(
            select(OpeningFamily).where(OpeningFamily.full_name == "Italian Game: Giuoco Piano")
        )

        assert first_count == 4
        assert second_count == 0
        assert row_count == 4
        assert main_line is not None and main_line.is_main_line
        assert fallback_main is not None and fallback_main.is_main_line

    await engine.dispose()
