"""Read-only audit of current engine evidence, recent imports, and plan latency."""

from __future__ import annotations

import argparse
import asyncio
import json
from datetime import UTC, datetime, timedelta
from time import perf_counter

import chess
from pydantic import ValidationError
from sqlalchemy import Integer, bindparam, func, select, text

from app.database import async_session_factory, engine
from app.engine_contract import (
    ENGINE_NAME,
    ENGINE_VERSION,
    MAX_PAIR_DEPTH_GAP,
    MIN_TRUSTED_DEPTH,
)
from app.models.analysis import AnalysisResult
from app.models.cloud_evaluation import CloudEvaluation
from app.models.game import Game
from app.models.position import Position
from app.models.position_outcome import PositionOutcome
from app.routers.games import unanalyzed_fens
from app.schemas.analysis import AnalysisEvaluationItemIn
from app.services.improvement import build_improvement_plan
from app.services.pgn_parser import parse_game_pgn
from app.services.position_outcomes import terminal_outcome
from app.services.progress_integrity import audit_progress
from app.services.game_scope import DEFAULT_MIN_USER_RATING


# Distinct parent/child position pairs the player decided, with both sides
# searched to a depth they share. The coverage number counts one row per game a
# decision occurred in; this counts the decision once, which is the unit a
# lesson is made from.
_DISTINCT_DECISIONS_SQL = text("""
WITH evaluated AS (
    SELECT position_id, max(depth) AS depth
    FROM analysis_results
    WHERE multipv_rank = 1 AND engine = :engine AND engine_version = :engine_version
      AND depth >= :min_depth AND (eval_cp IS NOT NULL OR eval_mate IS NOT NULL)
    GROUP BY position_id
),
decided AS (
    SELECT g.id AS game_id, g.user_color, gp.ply, gp.position_id
    FROM game_positions gp
    JOIN games g ON g.id = gp.game_id
    WHERE g.username = :username
      AND g.time_class IN ('rapid', 'blitz')
      AND CASE WHEN g.user_color = 'white' THEN g.white_rating
               ELSE g.black_rating END >= :min_user_rating
      AND gp.position_id IN (SELECT position_id FROM evaluated)
)
SELECT count(*) FROM (
    SELECT DISTINCT parent.position_id, child.position_id
    FROM decided child
    JOIN decided parent ON parent.game_id = child.game_id AND parent.ply = child.ply - 1
    JOIN evaluated ce ON ce.position_id = child.position_id
    JOIN evaluated pe ON pe.position_id = parent.position_id
    WHERE ABS(ce.depth - pe.depth) <= :max_pair_depth_gap
      AND (
          (child.user_color = 'white' AND child.ply % 2 = 1)
          OR (child.user_color = 'black' AND child.ply % 2 = 0)
      )
) distinct_decisions
""").bindparams(bindparam("min_depth", type_=Integer()), bindparam("max_pair_depth_gap", type_=Integer()))


def _hours_ago(hours: int) -> datetime:
    return datetime.now(UTC) - timedelta(hours=hours)


def summarize_evidence_inventory(rows) -> dict:
    """Split stored evaluations into what the planner can read and what it cannot.

    Only rows matching the active engine contract are ever joined into a
    decision, so rows from earlier engines are inert: they take up the table
    without being able to grade anything. Without this split a low coverage
    number reads as "nothing has been analyzed yet", when the true cause may be
    that the analysis exists under an engine the pipeline does not accept.
    """

    by_engine = [
        {
            "engine": engine_name,
            "engine_version": engine_version,
            "rows": int(row_count),
            "positions": int(position_count),
            "usable_for_learning": engine_name == ENGINE_NAME and engine_version == ENGINE_VERSION,
        }
        for engine_name, engine_version, row_count, position_count in rows
    ]
    total_rows = sum(entry["rows"] for entry in by_engine)
    usable_rows = sum(entry["rows"] for entry in by_engine if entry["usable_for_learning"])
    return {
        "by_engine": by_engine,
        "total_rows": total_rows,
        "usable_rows": usable_rows,
        "inert_rows": total_rows - usable_rows,
        # A share rather than a verdict: inert rows are not corruption, so this
        # informs the gate's coverage limitation instead of failing it.
        "usable_share": round(usable_rows / total_rows, 4) if total_rows else 0.0,
    }


_MASTER_THEORY_SQL = text("""
    SELECT
        (SELECT count(*) FROM position_moves
          WHERE master_game_count IS NOT NULL)           AS move_rows_fetched,
        (SELECT count(*) FROM position_moves
          WHERE master_game_count > 0)                   AS move_rows_with_games,
        (SELECT count(DISTINCT from_position_id) FROM position_moves
          WHERE master_game_count > 0)                   AS positions_with_book,
        (SELECT count(*) FROM positions
          WHERE master_total IS NOT NULL)                AS positions_fetched
""")

_SYNC_STATE_SQL = text("""
    SELECT provider, cooldown_until, last_status_code, last_error, updated_at
    FROM external_sync_states ORDER BY provider
""")


def summarize_master_theory(counts, sync_rows) -> dict:
    """Whether master theory is actually present, and why it is not.

    Theory deviation is the one learning surface that does not come from our own
    engine: `_MISTAKES_SQL` joins each decision against the master moves for its
    parent position, so with no book rows it can return nothing at all. That
    failure is silent in exactly the way a stopped crawl is -- the panel shows an
    empty state, which reads as "you have no deviations" rather than "the data
    this is computed from was never fetched". The explorer's own 401 is recorded
    in `external_sync_states` and nowhere a person would look, so surface it.
    """

    providers = [
        {
            "provider": provider,
            "last_status_code": int(status) if status is not None else None,
            "last_error": error,
            "cooling_down_until": cooldown.isoformat() if cooldown else None,
            "in_cooldown": bool(cooldown and cooldown > datetime.now(UTC)),
            "updated_at": updated.isoformat() if updated else None,
        }
        for provider, cooldown, status, error, updated in sync_rows
    ]
    usable = int(counts.move_rows_with_games or 0)
    blocked = [
        entry for entry in providers
        if entry["last_status_code"] in (401, 403) or entry["in_cooldown"]
    ]
    return {
        "move_rows_fetched": int(counts.move_rows_fetched or 0),
        "move_rows_with_games": usable,
        "positions_with_book": int(counts.positions_with_book or 0),
        "positions_fetched": int(counts.positions_fetched or 0),
        # The deviation surface needs book moves, not merely fetched rows: a row
        # recorded with a count of zero is a position the masters never played,
        # which grades nothing.
        "deviation_surface_available": usable > 0,
        "providers": providers,
        "blocked_providers": [entry["provider"] for entry in blocked],
    }


async def audit(username: str) -> dict:
    result: dict = {"username": username, "active_engine": ENGINE_NAME}
    async with async_session_factory() as session:
        result["learning_progress"] = await audit_progress(session, username)
        result["master_theory"] = summarize_master_theory(
            (await session.execute(_MASTER_THEORY_SQL)).one(),
            (await session.execute(_SYNC_STATE_SQL)).all(),
        )
        result["games"] = int(await session.scalar(select(func.count()).select_from(Game).where(Game.username == username)) or 0)
        result["evaluation_rows_checked"] = 0
        result["invalid_evaluation_ids"] = []
        result["notation_mismatch_ids"] = []
        # Every row, not only the ones matching the engine contract. Filtering
        # here used to mean a corrupt row under any other engine was invisible
        # to the audit — 16 such rows sat unreported, with both a centipawn and
        # a mate score, or "(none)" as the best move. Migration 018 keeps
        # foreign engines out of this table, so an unfiltered scan is both
        # cheaper and the only thing that can catch that constraint failing.
        rows = await session.stream(
            select(Position.fen, AnalysisResult)
            .join(AnalysisResult, AnalysisResult.position_id == Position.id)
            .execution_options(yield_per=100)
        )
        async for fen, evaluation in rows:
            result["evaluation_rows_checked"] += 1
            try:
                validated = AnalysisEvaluationItemIn(
                    fen=fen, depth=evaluation.depth, eval_cp=evaluation.eval_cp,
                    eval_mate=evaluation.eval_mate, best_move_uci=evaluation.best_move_uci,
                    pv_uci=evaluation.pv_uci, multipv_rank=evaluation.multipv_rank,
                )
                if evaluation.best_move_san and evaluation.best_move_san != validated.best_move_san:
                    result["notation_mismatch_ids"].append(evaluation.id)
            except (ValueError, ValidationError):
                result["invalid_evaluation_ids"].append(evaluation.id)
        # Where the stored evidence came from. The learning pipeline grades a
        # decision only from rows matching the active engine contract, so rows
        # left by earlier engines are inert: they occupy the table, and a
        # coverage number computed over them would be counting evidence the
        # planner will never read. Reporting the split keeps "coverage is low"
        # from being read as "nothing has been analyzed yet".
        inventory_rows = await session.execute(
            select(
                AnalysisResult.engine,
                AnalysisResult.engine_version,
                func.count().label("rows"),
                func.count(func.distinct(AnalysisResult.position_id)).label("positions"),
            )
            .where(AnalysisResult.multipv_rank == 1)
            .group_by(AnalysisResult.engine, AnalysisResult.engine_version)
            .order_by(func.count().desc())
        )
        inventory = summarize_evidence_inventory(inventory_rows.all())
        # What migration 018 moved out. These rows cannot grade a decision and
        # are not corruption; reporting them keeps the story of a low coverage
        # number complete instead of leaving the evidence apparently missing.
        inventory["quarantined"] = {
            "cloud_evaluations": int(
                await session.scalar(select(func.count()).select_from(CloudEvaluation)) or 0
            ),
            "legacy_analysis_results": int(
                await session.scalar(
                    select(func.count()).select_from(text("legacy_analysis_results"))
                ) or 0
            ),
        }
        # Is anything still analysing? A crawl that stops — a crashed container,
        # a queue handing out work it cannot turn into rows — leaves no error
        # anywhere, just a coverage number that quietly stops moving. Reporting
        # when the last evaluation landed makes a stall visible in one line.
        newest, last_hour, last_day = (await session.execute(
            select(
                func.max(AnalysisResult.analyzed_at),
                func.count().filter(AnalysisResult.analyzed_at >= _hours_ago(1)),
                func.count().filter(AnalysisResult.analyzed_at >= _hours_ago(24)),
            )
        )).one()
        inventory["freshness"] = {
            "newest_evaluation": newest.isoformat() if newest else None,
            "minutes_since": round((datetime.now(UTC) - newest).total_seconds() / 60, 1)
            if newest else None,
            "stored_last_hour": int(last_hour or 0),
            "stored_last_24h": int(last_day or 0),
        }
        result["evidence_inventory"] = inventory
        result["recent_imports_checked"] = 0
        result["terminal_outcomes_checked"] = 0
        result["invalid_terminal_outcome_ids"] = []
        outcomes = await session.stream(
            select(Position.fen, PositionOutcome).join(PositionOutcome, PositionOutcome.position_id == Position.id)
            .execution_options(yield_per=100)
        )
        async for fen, outcome in outcomes:
            result["terminal_outcomes_checked"] += 1
            if terminal_outcome(fen) != (outcome.white_result, outcome.reason):
                result["invalid_terminal_outcome_ids"].append(outcome.position_id)
        result["invalid_recent_game_ids"] = []
        games = await session.execute(
            select(Game.id, Game.pgn, Game.num_moves, Game.result)
            .where(Game.username == username, Game.time_class.in_(("rapid", "blitz")))
            .order_by(Game.played_at.desc(), Game.id.desc()).limit(25)
        )
        for game_id, pgn, num_moves, game_result in games:
            result["recent_imports_checked"] += 1
            try:
                parsed = parse_game_pgn(pgn)
                if parsed.num_moves != num_moves or parsed.result != game_result:
                    result["invalid_recent_game_ids"].append(game_id)
            except ValueError:
                result["invalid_recent_game_ids"].append(game_id)
        latencies = []
        for _ in range(2):
            start = perf_counter()
            plan = await build_improvement_plan(session, username=username)
            latencies.append(round((perf_counter() - start) * 1000, 1))
        result["plan_latency_ms"] = latencies
        result["training"] = {
            # Instances, one per game the decision occurred in. Not the number
            # of lessons available: the drill pipeline groups candidates by
            # position, so the distinct count below is what can ever become one.
            "analyzed_decisions": plan.summary.analyzed_decisions,
            "distinct_analyzed_decisions": int(
                await session.scalar(_DISTINCT_DECISIONS_SQL, {"username": username, "engine": ENGINE_NAME, "engine_version": ENGINE_VERSION,
                 "min_depth": MIN_TRUSTED_DEPTH, "max_pair_depth_gap": MAX_PAIR_DEPTH_GAP,
                 "min_user_rating": DEFAULT_MIN_USER_RATING}) or 0
            ),
            "total_decisions": plan.summary.total_decisions,
            "coverage_rate": plan.summary.coverage_rate,
            "candidate_positions": plan.summary.candidate_positions,
            "session_seconds": plan.summary.session_seconds,
            "confidence": plan.summary.prescription.confidence,
            "trends": [trend.model_dump(mode="json") for trend in plan.summary.trends],
        }
        queue_latencies = []
        for _ in range(2):
            start = perf_counter()
            queue = await unanalyzed_fens(
                username=username, color="both", time_class="rapid_blitz",
                min_depth=18, limit=24, session=session,
            )
            queue_latencies.append(round((perf_counter() - start) * 1000, 1))
        invalid_fens = 0
        terminal_fens = 0
        for fen in queue["fens"]:
            try:
                board = chess.Board(fen if len(fen.split()) == 6 else f"{fen} 0 1")
                invalid_fens += int(not board.is_valid())
                terminal_fens += int(not any(board.legal_moves))
            except ValueError:
                invalid_fens += 1
        result["analysis_queue"] = {
            "latency_ms": queue_latencies,
            "positions": len(queue["fens"]),
            "duplicate_positions": len(queue["fens"]) - len(set(queue["fens"])),
            "invalid_positions": invalid_fens,
            "terminal_positions": terminal_fens,
            "pairs_by_phase": queue["selected_decision_pairs_by_phase"],
        }
    await engine.dispose()
    failures = integrity_failures(result)
    result["integrity"] = {"passed": not failures, "failures": failures}
    return result


def integrity_failures(result: dict) -> list[str]:
    """Data-integrity gate, separate from coverage and predictive confidence."""
    checks = {
        "invalid_evaluation_ids": result["invalid_evaluation_ids"],
        "notation_mismatch_ids": result["notation_mismatch_ids"],
        "invalid_terminal_outcome_ids": result["invalid_terminal_outcome_ids"],
        "invalid_recent_game_ids": result["invalid_recent_game_ids"],
    }
    for key in ("duplicate_positions", "invalid_positions", "terminal_positions"):
        checks[f"analysis_queue.{key}"] = result["analysis_queue"][key]
    for key in (
        "attempt_count_mismatches", "invalid_progress_counters", "invalid_review_schedules",
        "attempt_groups_missing_progress", "idempotent_attempts_missing_receipts",
    ):
        checks[f"learning_progress.{key}"] = result["learning_progress"][key]
    return [key for key, value in checks.items() if value]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("username")
    args = parser.parse_args()
    report = asyncio.run(audit(args.username.lower()))
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report["integrity"]["passed"] else 1)
