from __future__ import annotations

import chess

from app.services.tactics import detect_motifs


def keys(motifs) -> list[str]:
    return [motif.key for motif in motifs]


def test_knight_fork_names_both_targets() -> None:
    motifs = detect_motifs(
        "r3k3/8/4N3/8/8/8/8/4K3 w - - 0 1",
        "e6c7",
        mover=chess.WHITE,
    )
    assert keys(motifs) == ["fork"]
    assert "king on e8" in motifs[0].detail
    assert "rook on a8" in motifs[0].detail


def test_bishop_pin_reports_the_shielded_piece() -> None:
    motifs = detect_motifs(
        "4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1",
        "f1b5",
        mover=chess.WHITE,
    )
    assert keys(motifs) == ["pin"]
    assert "pins the knight on c6 against the king on e8" in motifs[0].detail


def test_skewer_is_reported_when_the_king_stands_in_front() -> None:
    motifs = detect_motifs(
        "4q3/8/8/4k3/8/8/8/R5K1 w - - 0 1",
        "a1e1",
        mover=chess.WHITE,
    )
    assert keys(motifs) == ["skewer"]
    assert "king on e5" in motifs[0].detail
    assert "queen on e8" in motifs[0].detail


def test_back_rank_mate_reports_mate_first_then_the_back_rank_fact() -> None:
    motifs = detect_motifs(
        "6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1",
        "e1e8",
        mover=chess.WHITE,
    )
    assert keys(motifs) == ["mate", "back_rank"]
    assert "checkmate" in motifs[0].detail
    assert "back rank" in motifs[1].detail


def test_removing_the_defender_requires_the_line_to_win_the_guarded_piece() -> None:
    motifs = detect_motifs(
        "6k1/1p6/2n5/1B2b3/8/8/8/4R1K1 w - - 0 1",
        "b5c6 b7c6 e1e5",
        mover=chess.WHITE,
    )
    assert "removing_the_defender" in keys(motifs)
    detail = next(m.detail for m in motifs if m.key == "removing_the_defender")
    assert "knight" in detail
    assert "bishop" in detail


def test_only_the_named_movers_moves_are_inspected() -> None:
    """The same PV describes nothing for the side that is not moving."""

    motifs = detect_motifs(
        "r3k3/8/4N3/8/8/8/8/4K3 w - - 0 1",
        "e6c7",
        mover=chess.BLACK,
    )
    assert motifs == []


def test_hanging_forking_piece_without_check_is_not_claimed_as_a_fork() -> None:
    """A knight that simply drops itself is not evidence of a fork."""

    hanging = detect_motifs(
        "3rr3/2p5/8/1N6/8/8/8/4K2k w - - 0 1",
        "b5c7",
        mover=chess.WHITE,
    )
    assert keys(hanging) == []


def test_illegal_or_missing_principal_variation_yields_no_claims() -> None:
    assert detect_motifs("4k3/8/8/8/8/8/8/4K3 w - - 0 1", None, mover=chess.WHITE) == []
    assert detect_motifs("4k3/8/8/8/8/8/8/4K3 w - - 0 1", "a1a8", mover=chess.WHITE) == []
    assert detect_motifs("not-a-fen", "e2e4", mover=chess.WHITE) == []



def test_weak_line_ups_are_not_claimed_as_pins_or_skewers() -> None:
    """A pawn in front of a knight is geometry, not a tactic worth naming."""

    # Rook lands on a file with a black pawn shielding a black knight.
    assert (
        detect_motifs("1n6/1p6/8/8/8/8/8/1R2K1k1 w - - 0 1", "b1b2", mover=chess.WHITE) == []
    )
    # Bishop lands on a diagonal with a black knight shielding a black pawn.
    assert (
        detect_motifs("7k/8/5p2/4n3/8/8/1B6/4K3 w - - 0 1", "b2c1", mover=chess.WHITE) == []
    )


def test_absolute_and_material_winning_line_ups_are_still_reported() -> None:
    # Knight pinned against the king is a real absolute pin.
    pinned = detect_motifs("4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1", "f1b5", mover=chess.WHITE)
    assert keys(pinned) == ["pin"]
    # Queen in front of a rook is a real skewer.
    skewered = detect_motifs("3r4/8/8/8/3q4/7k/8/R3K3 w - - 0 1", "a1d1", mover=chess.WHITE)
    assert keys(skewered) == ["skewer"]
