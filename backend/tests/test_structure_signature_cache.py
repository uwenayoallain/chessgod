from unittest.mock import patch

import chess

from app.services.improvement import structure_signature

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"


def test_repeated_session_composition_reuses_immutable_structure_counts():
    structure_signature.cache_clear()
    try:
        with patch("app.services.improvement.chess.Board", wraps=chess.Board) as board:
            first = structure_signature(START)
            for _ in range(100):
                assert structure_signature(START) == first
            assert board.call_count == 1
            assert first == (1, 2, 2, 2, 1, 2, 2, 2, 0)
    finally:
        structure_signature.cache_clear()


def test_structure_cache_is_bounded_and_distinguishes_material():
    structure_signature.cache_clear()
    try:
        assert structure_signature.cache_info().maxsize == 4096
        assert structure_signature(START) != structure_signature("7k/8/8/8/8/8/P7/7K w - -")
        assert structure_signature("not a position") is None
    finally:
        structure_signature.cache_clear()
