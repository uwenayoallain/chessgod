from app.utils.opening_names import restore_apostrophes


def test_possessives_get_their_apostrophe_and_other_names_do_not() -> None:
    assert restore_apostrophes("Kings Pawn Opening 1...e5") == "King's Pawn Opening 1...e5"
    assert restore_apostrophes("Queens Pawn Opening Kings Indian Attack") == (
        "Queen's Pawn Opening King's Indian Attack"
    )
    assert restore_apostrophes("Alekhines Defense") == "Alekhine's Defense"
    assert restore_apostrophes("Mieses Opening") == "Mieses Opening"
    assert restore_apostrophes("Barnes Defense") == "Barnes Defense"
    assert restore_apostrophes("Kingside Fianchetto") == "Kingside Fianchetto"
    assert restore_apostrophes(None) is None
