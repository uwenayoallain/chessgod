"""Opt-in PostgreSQL lock tests, isolated in an automatically removed test schema.

`store_evaluations` takes a `FOR UPDATE` lock on the *position* rather than on
an analysis row, because the contended case is the first upload for a position,
where there is no analysis row to lock yet. These tests pin what that lock has
to buy under real row locking, which SQLite cannot exercise:

* overlapping uploads at different depths keep one row per searched depth
  (migration 017 — a move is graded by differencing two positions, so both sides
  need a depth they were actually searched to), and
* overlapping uploads of the *same* search collapse to a single row instead of
  racing into a unique-constraint violation on
  `(position_id, engine, multipv_rank, depth)`.

Distinct depths do not contend for the unique key, so the first test states the
storage contract and holds with or without the lock; the two same-depth tests
are the ones that fail when it is removed.

The sessions are opened and warmed *in parallel* before the concurrent phase on
purpose. Establishing an asyncpg connection costs tens of milliseconds — far
longer than the read-insert-commit being tested — so uploads that connect on
first use stagger themselves and the first one commits before the others have
issued a statement. Warming them one at a time does not help either: each
session hands its connection back on commit, so the next warms the same one and
the pool still holds a single connection. Measured against a build with the
lock removed: cold or serially warmed sessions never collide and these tests
pass without it; warmed in parallel the upload raises UniqueViolationError on
`analysis_results_position_id_engine_multipv_rank_depth_key`, which is the
failure the lock exists to prevent.
"""

import asyncio
import os
from contextlib import asynccontextmanager, suppress
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import engine as configured_engine
from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.position import Position
from app.routers.analysis import store_evaluations
from app.schemas.analysis import AnalysisEvaluationBatchIn, AnalysisEvaluationItemIn

FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"
UPLOADERS = 3

requires_postgres = pytest.mark.skipif(
    os.environ.get("CHESSGOD_TEST_POSTGRES") != "1",
    reason="Set CHESSGOD_TEST_POSTGRES=1 for the isolated PostgreSQL concurrency tests",
)


@asynccontextmanager
async def _contending_sessions(count: int = UPLOADERS):
    """Yield warmed sessions on a fresh schema holding only this test's rows."""

    schema = "chessgod_test_" + uuid4().hex
    engine = create_async_engine(configured_engine.url, pool_size=count + 2)
    scoped = engine.execution_options(schema_translate_map={None: schema})
    sessions = async_sessionmaker(scoped, expire_on_commit=False)
    open_sessions: list = []
    try:
        async with engine.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        async with scoped.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as session:
            session.add(Position(fen=FEN, total_games=0))
            await session.commit()

        open_sessions = [sessions() for _ in range(count)]
        # Connect all of them at once so the pool really holds `count` live
        # connections and the concurrent phase is a race rather than a queue.
        # The timeout bounds the wait, so a lost lock surfaces as a failed test
        # rather than a run that hangs on a block that will never clear.
        await asyncio.gather(*(
            session.execute(text("SET statement_timeout = '10s'")) for session in open_sessions
        ))
        for session in open_sessions:
            await session.commit()
        yield sessions, open_sessions
    finally:
        for session in open_sessions:
            # A session left mid-rollback by a failing upload refuses close();
            # that must not mask the failure being reported.
            with suppress(Exception):
                await session.close()
        # This exact schema was created above and contains only this test's rows.
        async with engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await engine.dispose()


def _upload(session, *, depth: int, eval_cp: int, best_move_uci: str = "e2e4"):
    return store_evaluations(
        AnalysisEvaluationBatchIn(items=[AnalysisEvaluationItemIn(
            fen=FEN, depth=depth, eval_cp=eval_cp, best_move_uci=best_move_uci,
        )]),
        session=session,
    )


async def _rows(sessions) -> list[AnalysisResult]:
    async with sessions() as session:
        return list(await session.scalars(select(AnalysisResult)))


@pytest.mark.asyncio
@requires_postgres
async def test_concurrent_uploads_keep_one_row_per_searched_depth() -> None:
    async with _contending_sessions() as (sessions, open_sessions):
        depths = (22, 30, 18)
        results = await asyncio.wait_for(
            asyncio.gather(*(
                _upload(session, depth=depth, eval_cp=depth)
                for session, depth in zip(open_sessions, depths)
            )),
            timeout=30,
        )

        assert sum(result["stored"] for result in results) == 3
        assert sum(result["skipped"] for result in results) == 0
        # Each search survives at the depth it ran, so a decision can be measured
        # at a depth both of its positions reached. Collapsing to the deepest row
        # would leave the 18 and 22 searches with nothing to pair against.
        assert {row.depth: row.eval_cp for row in await _rows(sessions)} == {18: 18, 22: 22, 30: 30}


@pytest.mark.asyncio
@requires_postgres
async def test_concurrent_duplicate_uploads_store_one_row() -> None:
    async with _contending_sessions() as (sessions, open_sessions):
        # The same search re-uploaded by overlapping requests: a retry, a
        # replayed batch, two tabs crawling the same position. Without the
        # position lock these read past each other's uncommitted insert and
        # collide on the unique constraint.
        results = await asyncio.wait_for(
            asyncio.gather(*(
                _upload(session, depth=22, eval_cp=35) for session in open_sessions
            )),
            timeout=30,
        )

        assert sum(result["stored"] for result in results) == 1
        assert sum(result["skipped"] for result in results) == UPLOADERS - 1
        rows = await _rows(sessions)
        assert len(rows) == 1
        assert (rows[0].depth, rows[0].eval_cp) == (22, 35)


@pytest.mark.asyncio
@requires_postgres
async def test_concurrent_reruns_at_one_depth_keep_the_newest_reading() -> None:
    async with _contending_sessions() as (sessions, open_sessions):
        await _upload(open_sessions[0], depth=22, eval_cp=35)
        first_seen = (await _rows(sessions))[0].analyzed_at

        # A genuinely fresh search of the same position to the same depth is new
        # evidence, not a retry, so the first writer overwrites the stored row
        # and the rest recognise their own reading and skip.
        results = await asyncio.wait_for(
            asyncio.gather(*(
                _upload(session, depth=22, eval_cp=41, best_move_uci="d2d4")
                for session in open_sessions
            )),
            timeout=30,
        )

        assert sum(result["stored"] for result in results) == 1
        assert sum(result["skipped"] for result in results) == UPLOADERS - 1
        rows = await _rows(sessions)
        assert len(rows) == 1
        assert (rows[0].eval_cp, rows[0].best_move_uci) == (41, "d2d4")
        assert rows[0].analyzed_at > first_seen
