from app.engine_contract import DECISIVE_CP
from app.services.improvement import (
    _CANDIDATES_SQL,
    _TREND_ROWS_SQL,
    _format_mover_eval,
    classify_pattern,
)
from app.services.mistakes import _MISTAKES_SQL


def test_every_learning_query_caps_centipawns_at_the_decisive_scale():
    # A tablebase win reported as +80 must not rank as an 80-pawn blunder on
    # one surface while another reads it differently.
    for sql in (_CANDIDATES_SQL, _TREND_ROWS_SQL, _MISTAKES_SQL):
        assert f"WHEN ar.eval_cp > {DECISIVE_CP} THEN {DECISIVE_CP}" in sql.text
        assert f"WHEN ar.eval_cp < -{DECISIVE_CP} THEN -{DECISIVE_CP}" in sql.text


def test_cap_stays_below_the_mate_scale():
    # Mate in 20 maps to 1,800; any centipawn score must stay under it so a
    # forced mate always outranks one.
    assert DECISIVE_CP < 1800


def test_mover_eval_reads_as_a_position_not_a_pawn_count():
    assert _format_mover_eval(1500) == "+15.0"
    assert _format_mover_eval(-30) == "-0.3"
    assert _format_mover_eval(1990) == "mate for you"
    assert _format_mover_eval(-2000) == "mate against you"


def test_explanation_keeps_a_mistake_made_while_still_winning():
    # A mistake that leaves the mover winning is still a mistake worth drilling;
    # the wording shows the position was won before and after rather than
    # hiding it or inflating it.
    pattern = classify_pattern(
        fen="6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1",
        ply=41,
        user_move_uci="g1f1",
        best_move_uci="d1d8",
        opponent_reply_uci=None,
        parent_eval_cp=1500,
        mover_is_white=True,
        eval_drop_cp=600,
        user_move_san="Kf1",
        best_move_san="Rd8#",
    )
    assert "from +15.0 to +9.0" in pattern.explanation
    assert "pawns of evaluation" not in pattern.explanation
