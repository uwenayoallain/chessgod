from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.repertoire_mark import RepertoireMark
from app.routers import theory
from app.schemas.theory import RepertoireMarkIn
from app.services.cache import get_shared_cache


@pytest.mark.asyncio
async def test_mark_writes_commit_before_invalidating_both_repertoire_caches(monkeypatch) -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(RepertoireMark.__table__.create)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    cache = get_shared_cache()
    bases = ("repertoire:tester:black:12", "improvement:repertoire:tester:black:rapid:1000")
    last_key = "training:repertoirelast:tester:black:rapid:1000"
    invalidate = theory.invalidate_repertoire_cache

    async def seed_caches():
        for base in bases:
            await cache.set_json(await cache.versioned_key(base), ["old"], ttl_seconds=60)
        await cache.set_json(last_key, ["old"], ttl_seconds=60)

    async with factory() as session:
        async def after_commit(*args):
            assert not session.in_transaction()
            await invalidate(*args)

        check_commit = AsyncMock(side_effect=after_commit)
        monkeypatch.setattr(theory, "invalidate_repertoire_cache", check_commit)
        payload = RepertoireMarkIn(
            username="tester", color="black", fen="after-e4",
            intended_move_san="e5", intended_move_uci="e7e5",
        )
        await seed_caches()
        mark = await theory.mark_repertoire(payload, session=session)
        assert mark.intended_move_uci == "e7e5"
        for base in bases:
            assert await cache.get_json(await cache.versioned_key(base)) is None
        assert await cache.get_json(last_key) is None

        await seed_caches()
        result = await theory.unmark_repertoire(
            username=payload.username, fen=payload.fen, color=payload.color, session=session,
        )
        assert result.status_code == 204
        assert check_commit.await_count == 2
        for base in bases:
            assert await cache.get_json(await cache.versioned_key(base)) is None
        assert await cache.get_json(last_key) is None

    await engine.dispose()
