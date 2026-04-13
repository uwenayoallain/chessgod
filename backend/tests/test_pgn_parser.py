from app.services.pgn_parser import parse_game_pgn


SAMPLE_PGN = """
[Event "Live Chess"]
[Site "Chess.com"]
[Date "2024.03.05"]
[Round "-"]
[White "alpha"]
[Black "beta"]
[Result "1-0"]
[CurrentPosition "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"]
[Timezone "UTC"]
[ECO "C20"]
[ECOUrl "https://www.chess.com/openings/Kings-Pawn-Game"]
[UTCDate "2024.03.05"]
[UTCTime "12:00:00"]
[WhiteElo "1500"]
[BlackElo "1480"]
[TimeControl "600"]
[EndDate "2024.03.05"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 1-0
""".strip()


def test_parse_game_pgn_extracts_positions_and_metadata() -> None:
    parsed = parse_game_pgn(SAMPLE_PGN)

    assert parsed.white_username == "alpha"
    assert parsed.black_username == "beta"
    assert parsed.result == "1-0"
    assert parsed.eco == "C20"
    assert parsed.opening_name == "Kings Pawn Game"
    assert parsed.time_control == "600"
    assert parsed.white_rating == 1500
    assert parsed.black_rating == 1480
    assert parsed.num_moves == 5
    assert parsed.positions[0].ply == 0
    assert parsed.positions[1].move_san == "e4"
    assert parsed.positions[2].move_uci == "e7e5"
    assert parsed.positions[-1].fen.startswith("r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3")
