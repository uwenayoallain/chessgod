from __future__ import annotations

import io
from dataclasses import dataclass

import chess.pgn

from app.utils.fen import normalize_fen


@dataclass
class PositionRecord:
    fen: str
    move_san: str | None
    move_uci: str | None
    ply: int


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


def parse_game_pgn(pgn_text: str) -> ParsedGame:
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        raise ValueError("Could not parse PGN")

    board = game.board()
    positions = [PositionRecord(fen=normalize_fen(board.fen()), move_san=None, move_uci=None, ply=0)]

    for ply, move in enumerate(game.mainline_moves(), start=1):
        san = board.san(move)
        uci = move.uci()
        board.push(move)
        positions.append(PositionRecord(fen=normalize_fen(board.fen()), move_san=san, move_uci=uci, ply=ply))

    headers = game.headers
    eco_url = headers.get("ECOUrl")
    opening_name = eco_url.split("/")[-1].replace("-", " ") if eco_url else headers.get("Opening")

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
