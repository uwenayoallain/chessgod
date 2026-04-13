from app.services.common_book import get_common_book_moves, is_common_book_move


STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"


def test_common_book_contains_mainline_starting_moves() -> None:
    moves = {entry["uci"] for entry in get_common_book_moves(STARTING_FEN)}

    assert "e2e4" in moves
    assert "d2d4" in moves
    assert "c2c4" in moves


def test_is_common_book_move_supports_uci_and_san() -> None:
    assert is_common_book_move(STARTING_FEN, "e2e4")
    assert is_common_book_move(STARTING_FEN, None, "e4")
    assert not is_common_book_move(STARTING_FEN, "a2a5")
