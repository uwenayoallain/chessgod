import pytest

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

1. e4 {[%clk 0:09:57.2]} e5 {[%clk 0:09:56.4]}
2. Nf3 {[%clk 0:09:51.1]} Nc6 {[%clk 0:09:49.0]} 3. Bc4 1-0
""".strip()


def test_parse_game_pgn_extracts_positions_and_metadata() -> None:
    parsed = parse_game_pgn(SAMPLE_PGN)

    assert parsed.white_username == "alpha"
    assert parsed.black_username == "beta"
    assert parsed.result == "1-0"
    assert parsed.eco == "C20"
    assert parsed.opening_name == "King's Pawn Game"
    assert parsed.time_control == "600"
    assert parsed.white_rating == 1500
    assert parsed.black_rating == 1480
    assert parsed.num_moves == 5
    assert parsed.positions[0].ply == 0
    assert parsed.positions[1].move_san == "e4"
    assert parsed.positions[2].move_uci == "e7e5"
    assert parsed.positions[1].clock_seconds_after == 597.2
    assert parsed.positions[1].think_seconds == pytest.approx(2.8)
    assert parsed.positions[3].clock_seconds_after == 591.1
    assert parsed.positions[3].think_seconds == pytest.approx(6.1)
    assert parsed.positions[5].clock_seconds_after is None
    assert parsed.positions[5].think_seconds is None
    assert parsed.positions[-1].fen.startswith("r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3")


def test_missing_clock_does_not_attribute_several_moves_to_one_turn() -> None:
    parsed = parse_game_pgn('[TimeControl "300+2"]\n\n1. e4 {[%clk 0:04:59]} e5 2. Nf3 Nc6 3. Bc4 {[%clk 0:04:40]} Nf6 4. d3 {[%clk 0:04:35]} *')
    assert parsed.positions[1].think_seconds == 3
    assert parsed.positions[5].think_seconds is None
    assert parsed.positions[7].think_seconds == 7


def test_invalid_pgn_is_not_silently_imported_as_a_shorter_game() -> None:
    with pytest.raises(ValueError, match="truncated"):
        parse_game_pgn('1. e4 e5 2. Bh6 1-0')


def test_variant_games_are_rejected() -> None:
    with pytest.raises(ValueError, match="standard chess"):
        parse_game_pgn('[Variant "Crazyhouse"]\n\n1. e4 e5 *')
