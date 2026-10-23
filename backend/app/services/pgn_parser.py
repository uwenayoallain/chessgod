from __future__ import annotations

import io
from dataclasses import dataclass

import chess.pgn

from app.utils.fen import normalize_fen
from app.utils.opening_names import restore_apostrophes


@dataclass
class PositionRecord:
    fen: str
    move_san: str | None
    move_uci: str | None
    ply: int
    clock_seconds_after: float | None = None
    think_seconds: float | None = None


@dataclass
class ParsedGame:
    positions: list[PositionRecord]
    white_username: str
    black_username: str
    result: str
    eco: str | None
    opening_name: str | None
    time_class: str | None
    time_control: str | None
    white_rating: int | None
    black_rating: int | None
    played_at: str | None
    num_moves: int


def safe_int(value: str | None) -> int | None:
    try:
        return int(value) if value else None
    except (TypeError, ValueError):
        return None


def _clock_control(time_control: str | None) -> tuple[float | None, float]:
    """Return starting seconds and Fischer increment for live-game controls."""

    if not time_control or "/" in time_control:
        return None, 0.0
    parts = time_control.split("+", 1)
    try:
        initial = float(parts[0])
        increment = float(parts[1]) if len(parts) == 2 else 0.0
    except ValueError:
        return None, 0.0
    return initial, increment


def parse_game_pgn(pgn_text: str) -> ParsedGame:
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        raise ValueError("Could not parse PGN")
    if game.errors:
        raise ValueError("PGN contains invalid moves; refusing a truncated game")
    if game.headers.get("Variant", "Standard").lower() not in {"standard", "chess"}:
        raise ValueError("Only standard chess is supported")

    board = game.board()
    initial_seconds, increment_seconds = _clock_control(game.headers.get("TimeControl"))
    previous_clock = {chess.WHITE: initial_seconds, chess.BLACK: initial_seconds}
    positions = [PositionRecord(fen=normalize_fen(board.fen()), move_san=None, move_uci=None, ply=0)]

    for ply, node in enumerate(game.mainline(), start=1):
        move = node.move
        mover = board.turn
        san = board.san(move)
        uci = move.uci()
        board.push(move)
        clock_after = node.clock()
        clock_before = previous_clock[mover]
        think_seconds = None
        if clock_after is not None and clock_before is not None:
            think_seconds = max(0.0, clock_before + increment_seconds - clock_after)
        # A missing annotation breaks the chain: the next difference would
        # otherwise span several moves and misreport a single thinking time.
        previous_clock[mover] = clock_after
        positions.append(
            PositionRecord(
                fen=normalize_fen(board.fen()),
                move_san=san,
                move_uci=uci,
                ply=ply,
                clock_seconds_after=clock_after,
                think_seconds=think_seconds,
            )
        )

    headers = game.headers
    eco_url = headers.get("ECOUrl")
    opening_name = restore_apostrophes(
        eco_url.split("/")[-1].replace("-", " ") if eco_url else headers.get("Opening")
    )

    return ParsedGame(
        positions=positions,
        white_username=headers.get("White", ""),
        black_username=headers.get("Black", ""),
        result=headers.get("Result", "*"),
        eco=headers.get("ECO"),
        opening_name=opening_name,
        time_class=headers.get("TimeClass"),
        time_control=headers.get("TimeControl"),
        white_rating=safe_int(headers.get("WhiteElo")),
        black_rating=safe_int(headers.get("BlackElo")),
        played_at=headers.get("EndDate"),
        num_moves=max(0, len(positions) - 1),
    )
