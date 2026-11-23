from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.position import Position
from app.routers.analysis import analysis_activity
from app.services.cache import get_shared_cache


@pytest.mark.asyncio
async def test_analysis_activity_preserves_the_newest_timestamp_outside_the_recent_window() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    now = datetime.now(UTC)
    old = now - timedelta(days=2)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        session.add(Position(id=1, fen="start"))
        session.add(AnalysisResult(
            position_id=1, depth=16, best_move_uci="e2e4", best_move_san="e4", analyzed_at=old,
        ))
        await session.commit()
        activity = await analysis_activity(session)
        assert activity["newest_evaluation"] == old.isoformat()
        assert (activity["stored_last_hour"], activity["stored_last_24h"]) == (0, 0)

        newest = now - timedelta(minutes=5)
        session.add_all([
            AnalysisResult(
                position_id=1, depth=depth, best_move_uci="e2e4", best_move_san="e4", analyzed_at=when,
            )
            for depth, when in [(17, now - timedelta(hours=2)), (18, newest)]
        ])
        await session.commit()
        await get_shared_cache().delete_prefix("analysis:activity:")
        activity = await analysis_activity(session)
        assert activity["newest_evaluation"] == newest.isoformat()
        assert (activity["stored_last_hour"], activity["stored_last_24h"]) == (1, 2)
    await engine.dispose()
