from app.utils.fen import normalize_fen


def test_normalize_fen_strips_move_counters_only() -> None:
    fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"

    assert normalize_fen(fen) == "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3"


def test_normalize_fen_leaves_four_field_fen_unchanged() -> None:
    fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"

    assert normalize_fen(fen) == fen
