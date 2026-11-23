"""A review's costly moves are named with the drill classifier."""

from __future__ import annotations

import pytest

from app.routers.analysis import explain_moves
from app.schemas.analysis import MoveExplanationIn, MoveExplanationsIn

# 1.e4 c5 2.Qh5 b6: White to move; 3.Qxf7+?? Kxf7 gives the queen away.
AFTER_B6 = "rnbqkbnr/p2ppppp/1p6/2p4Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq -"


def item(**overrides) -> MoveExplanationIn:
    return MoveExplanationIn(**{
        "fen": AFTER_B6, "ply": 5, "user_move_uci": "h5f7", "best_move_uci": "g1f3",
        "best_pv_uci": "g1f3 g8f6", "reply_pv_uci": "e8f7", "parent_eval_cp": 80,
        "eval_drop_cp": 887, **overrides,
    })


@pytest.mark.asyncio
async def test_a_hung_piece_names_the_capture_that_wins_it():
    [explained] = await explain_moves(MoveExplanationsIn(items=[item()]))
    assert (explained.ply, explained.key, explained.label) == (5, "hanging_material", "Hanging material")
    assert explained.detail == "Kxf7 wins the queen."
    assert explained.cue


@pytest.mark.asyncio
async def test_a_move_that_does_not_play_is_left_out():
    assert await explain_moves(MoveExplanationsIn(items=[item(user_move_uci="h5h8")])) == []
