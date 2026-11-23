import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "audit_system", Path(__file__).parents[2] / "scripts/audit_system.py",
)
audit_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_module)


def clean_report():
    return {
        "invalid_evaluation_ids": [], "notation_mismatch_ids": [],
        "invalid_terminal_outcome_ids": [], "invalid_recent_game_ids": [],
        "analysis_queue": {"duplicate_positions": 0, "invalid_positions": 0, "terminal_positions": 0},
        "learning_progress": {
            "attempt_count_mismatches": 0, "invalid_progress_counters": 0,
            "invalid_review_schedules": 0, "attempt_groups_missing_progress": 0,
            "idempotent_attempts_missing_receipts": 0,
        },
        "training": {"coverage_rate": 0.0, "confidence": "low"},
    }


def test_sparse_evidence_is_not_reported_as_corruption():
    assert audit_module.integrity_failures(clean_report()) == []


def test_distinct_decisions_use_the_training_time_class_and_player_rating_scope():
    import sqlite3

    with sqlite3.connect(":memory:") as db:
        db.executescript("""
            CREATE TABLE games (id INTEGER, username TEXT, user_color TEXT,
                                time_class TEXT, white_rating INTEGER, black_rating INTEGER);
            CREATE TABLE game_positions (game_id INTEGER, ply INTEGER, position_id INTEGER);
            CREATE TABLE analysis_results (position_id INTEGER, depth INTEGER,
                multipv_rank INTEGER, engine TEXT, engine_version TEXT, eval_cp INTEGER, eval_mate INTEGER);
        """)
        cases = [
            ("white", "rapid", 1200, 800),   # Player qualifies; opponent need not.
            ("black", "blitz", 800, 1200),
            ("white", "bullet", 1200, 1200),
            ("white", "rapid", 800, 1200),
            ("black", "blitz", 1200, 800),
            ("black", "rapid", 1200, None),
        ]
        for game_id, (color, time_class, white, black) in enumerate(cases, 1):
            db.execute("INSERT INTO games VALUES (?, 'tester', ?, ?, ?, ?)",
                       (game_id, color, time_class, white, black))
            child_ply = 1 if color == "white" else 2
            for offset in (0, 1):
                position_id = game_id * 2 + offset
                db.execute("INSERT INTO game_positions VALUES (?, ?, ?)",
                           (game_id, child_ply - 1 + offset, position_id))
                db.execute("INSERT INTO analysis_results VALUES (?, 22, 1, ?, ?, 30, NULL)",
                           (position_id, audit_module.ENGINE_NAME, audit_module.ENGINE_VERSION))
        count = db.execute(str(audit_module._DISTINCT_DECISIONS_SQL), {
            "username": "tester", "engine": audit_module.ENGINE_NAME,
            "engine_version": audit_module.ENGINE_VERSION, "min_depth": 18,
            "max_pair_depth_gap": 3, "min_user_rating": 1000,
        }).fetchone()[0]
        assert count == 2


@pytest.mark.parametrize("section,key", [
    (None, "invalid_evaluation_ids"), (None, "notation_mismatch_ids"),
    (None, "invalid_terminal_outcome_ids"), (None, "invalid_recent_game_ids"),
    *[("analysis_queue", key) for key in clean_report()["analysis_queue"]],
    *[("learning_progress", key) for key in clean_report()["learning_progress"]],
])
def test_each_integrity_failure_is_reported(section, key):
    report = clean_report()
    if section is None:
        report[key] = [123]
    else:
        report[section][key] = 1
    assert audit_module.integrity_failures(report) == [f"{section}.{key}" if section else key]


def test_evidence_inventory_separates_usable_rows_from_inert_ones():
    # Rows left by an engine the pipeline no longer accepts still sit in the
    # table. They cannot grade a decision, so a coverage number that looked only
    # at row counts would describe evidence the planner never reads.
    summary = audit_module.summarize_evidence_inventory([
        ("stockfish", "Stockfish 17.1", 6759, 6759),
        ("lichess-cloud", None, 1125, 1125),
        (audit_module.ENGINE_NAME, audit_module.ENGINE_VERSION, 209, 207),
    ])

    assert summary["total_rows"] == 8093
    assert summary["usable_rows"] == 209
    assert summary["inert_rows"] == 7884
    assert summary["usable_share"] == 0.0258
    assert [entry["usable_for_learning"] for entry in summary["by_engine"]] == [False, False, True]


def test_evidence_inventory_on_an_empty_table_reports_no_share():
    summary = audit_module.summarize_evidence_inventory([])

    assert summary == {
        "by_engine": [], "total_rows": 0, "usable_rows": 0,
        "inert_rows": 0, "usable_share": 0.0,
    }


def test_evidence_inventory_counts_a_version_mismatch_as_inert():
    # Same engine name, different contract version: the pipeline's filter pins
    # both, so a version drift silently strands every row behind it.
    summary = audit_module.summarize_evidence_inventory([
        (audit_module.ENGINE_NAME, "18", 400, 400),
        (audit_module.ENGINE_NAME, audit_module.ENGINE_VERSION, 100, 100),
    ])

    assert summary["usable_rows"] == 100
    assert summary["inert_rows"] == 400


class _Counts:
    def __init__(self, fetched, with_games, positions_with_book, positions_fetched):
        self.move_rows_fetched = fetched
        self.move_rows_with_games = with_games
        self.positions_with_book = positions_with_book
        self.positions_fetched = positions_fetched


def _sync_row(provider, status=None, error=None, cooldown=None):
    return (provider, cooldown, status, error, None)


def test_fetched_rows_without_master_games_do_not_count_as_a_deviation_surface():
    # 7,786 rows were written and every one recorded zero master games, which is
    # what a 401'd sync leaves behind. Counting "fetched" would report the
    # surface as available while it can grade nothing.
    summary = audit_module.summarize_master_theory(
        _Counts(7786, 0, 0, 0), [_sync_row("lichess_opening_explorer", 401, "authorization")],
    )
    assert summary["move_rows_fetched"] == 7786
    assert summary["deviation_surface_available"] is False


def test_an_unauthorized_explorer_is_named_rather_than_left_silent():
    summary = audit_module.summarize_master_theory(
        _Counts(0, 0, 0, 0), [_sync_row("lichess_opening_explorer", 401, "authorization")],
    )
    assert summary["blocked_providers"] == ["lichess_opening_explorer"]


def test_a_healthy_book_reports_the_surface_as_available():
    summary = audit_module.summarize_master_theory(
        _Counts(7786, 5000, 1200, 900), [_sync_row("lichess_opening_explorer", 200)],
    )
    assert summary["deviation_surface_available"] is True
    assert summary["blocked_providers"] == []


def test_a_rate_limited_provider_still_in_cooldown_is_reported_blocked():
    from datetime import UTC, datetime, timedelta

    future = datetime.now(UTC) + timedelta(hours=1)
    summary = audit_module.summarize_master_theory(
        _Counts(10, 10, 5, 5), [_sync_row("lichess_cloud_eval", 429, "rate_limit", future)],
    )
    assert summary["blocked_providers"] == ["lichess_cloud_eval"]
    assert summary["providers"][0]["in_cooldown"] is True
