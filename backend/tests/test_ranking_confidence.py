import pytest

from app.services.improvement import _ranking_confidence


@pytest.mark.parametrize("positions,recurrence,analyzed,total,expected", [
    (100, "habit", 10_000, 93_945, "low"),
    (100, "habit", 999, 1000, "low"),
    (20, "habit", 20, 20, "low"),
    (20, "habit", 499, 499, "low"),
    (20, "habit", 500, 500, "medium"),
    (20, "repeated", 500, 500, "medium"),
    (19, "habit", 500, 500, "low"),
    (1, "one_off", 500, 500, "low"),
    (0, "one_off", 0, 0, "low"),
    (100, "habit", 1001, 1000, "low"),
])
def test_overall_ranking_confidence_respects_missing_and_small_samples(
    positions, recurrence, analyzed, total, expected,
):
    assert _ranking_confidence(positions=positions, recurrence=recurrence,
                               analyzed_decisions=analyzed, total_decisions=total) == expected
