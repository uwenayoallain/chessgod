import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.base import Base
from app.models.opening_family import OpeningFamily
from app.routers.theory import get_family_detail, theory_families


@pytest.mark.asyncio
async def test_theory_families_returns_roots_with_child_counts() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        root = OpeningFamily(full_name="Italian Game", display_name="Italian Game", root_fen="italian", pgn="1. e4", depth=0)
        session.add(root)
        await session.flush()
        session.add(
            OpeningFamily(
                parent_id=root.id,
                full_name="Italian Game: Giuoco Piano",
                display_name="Giuoco Piano",
                root_fen="giuoco",
                pgn="1. e4 e5",
                depth=1,
                is_main_line=True,
            )
        )
        await session.commit()

        families = await theory_families(username=None, color="both", time_class=None, parent_id=None, session=session)

        assert len(families) == 1
        assert families[0].full_name == "Italian Game"
        assert families[0].child_count == 1
        assert families[0].user_game_count == 0

    await engine.dispose()


@pytest.mark.asyncio
async def test_family_detail_returns_ancestors_children_and_position_tree() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        root = OpeningFamily(full_name="Italian Game", display_name="Italian Game", root_fen="italian", pgn="1. e4", depth=0)
        session.add(root)
        await session.flush()
        child = OpeningFamily(
            parent_id=root.id,
            full_name="Italian Game: Giuoco Piano",
            display_name="Giuoco Piano",
            root_fen="giuoco",
            pgn="1. e4 e5",
            depth=1,
            is_main_line=True,
        )
        session.add(child)
        await session.flush()
        session.add(
            OpeningFamily(
                parent_id=child.id,
                full_name="Italian Game: Giuoco Piano, Main Line",
                display_name="Main Line",
                root_fen="main-line",
                pgn="1. e4 e5 2. Nf3",
                depth=2,
                is_main_line=True,
            )
        )
        await session.commit()

        detail = await get_family_detail(child.id, username=None, color="both", time_class=None, include_mistakes=False, session=session)

        assert detail.family.full_name == "Italian Game: Giuoco Piano"
        assert [ancestor.full_name for ancestor in detail.ancestors] == ["Italian Game"]
        assert [grandchild.display_name for grandchild in detail.children] == ["Main Line"]
        assert detail.position_tree.fen == "giuoco"

    await engine.dispose()


@pytest.mark.asyncio
async def test_family_detail_does_not_load_mistakes_by_default() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        root = OpeningFamily(full_name="Italian Game", display_name="Italian Game", root_fen="italian", pgn="1. e4", depth=0)
        session.add(root)
        await session.commit()

        detail = await get_family_detail(root.id, username="tester", color="both", time_class=None, session=session)

        assert detail.top_mistakes == []

    await engine.dispose()
