"""Read-only reconciliation of learning counters with their source attempts."""

from sqlalchemy import String, and_, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.drill_progress import DrillAttempt, DrillProgress


async def audit_progress(session: AsyncSession, username: str) -> dict[str, int]:
    history = select(
        DrillAttempt.position_id.label("position_id"),
        DrillAttempt.expected_move_uci.label("move"),
        func.count().label("attempts"),
        func.sum(DrillAttempt.correct).label("correct"),
    ).where(DrillAttempt.username == username).group_by(
        DrillAttempt.position_id, DrillAttempt.expected_move_uci,
    ).subquery()
    result = dict(progress_rows_checked=0, attempt_count_mismatches=0,
                  invalid_progress_counters=0, invalid_review_schedules=0, tracked_attempts=0)
    rows = await session.stream(
        select(DrillProgress, history.c.attempts, history.c.correct)
        .outerjoin(history, and_(
            history.c.position_id == DrillProgress.position_id,
            history.c.move == DrillProgress.expected_move_uci,
        ))
        .where(DrillProgress.username == username)
        .execution_options(yield_per=100)
    )
    async for progress, attempts, correct in rows:
        result["progress_rows_checked"] += 1
        result["tracked_attempts"] += progress.attempts
        result["attempt_count_mismatches"] += int(
            progress.attempts != (attempts or 0) or progress.correct_attempts != (correct or 0)
        )
        result["invalid_progress_counters"] += int(not (
            0 <= progress.correct_attempts <= progress.attempts
            and 0 <= progress.streak <= progress.correct_attempts
            and progress.interval_days >= 0
        ))
        # Comparisons reject NaN and infinities as well as out-of-range values.
        # Do not repair history here: report corruption without rewriting recall.
        result["invalid_review_schedules"] += int(not (
            0 <= progress.interval_days <= 60 and 1.3 <= progress.ease_factor <= 2.8
        ))
    matching_progress = select(DrillProgress.id).where(
        DrillProgress.username == username,
        DrillProgress.position_id == history.c.position_id,
        DrillProgress.expected_move_uci == history.c.move,
    ).exists()
    result["attempt_groups_missing_progress"] = int(await session.scalar(
        select(func.count()).select_from(history).where(~matching_progress)
    ) or 0)
    # SQL NULL and JSON null both decode to None, but need different SQL tests.
    result["idempotent_attempts_missing_receipts"] = int(await session.scalar(
        select(func.count()).select_from(DrillAttempt).where(
            DrillAttempt.username == username,
            DrillAttempt.request_id.is_not(None),
            or_(DrillAttempt.result_snapshot.is_(None), cast(DrillAttempt.result_snapshot, String) == "null"),
        )
    ) or 0)
    return result
