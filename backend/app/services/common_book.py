from __future__ import annotations

import csv
from functools import lru_cache
from pathlib import Path

import chess

from app.utils.fen import normalize_fen


BOOK_TSV_FILES = ("a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv")


def _book_data_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "data" / "openings"


def _extract_san_moves(pgn_line: str) -> list[str]:
    tokens = pgn_line.strip().split()
    moves: list[str] = []

    for token in tokens:
        stripped = token.strip()
        if not stripped:
            continue
        if stripped in {"1-0", "0-1", "1/2-1/2", "*"}:
            continue
        if stripped[0].isdigit() and "." in stripped:
            if stripped.endswith("..."):
                continue
            parts = stripped.split(".")
            san = parts[-1].strip()
            if san:
                moves.append(san)
            continue
        moves.append(stripped)

    return moves


def _build_book_index() -> dict[str, dict[str, str]]:
    book_index: dict[str, dict[str, str]] = {}
    data_dir = _book_data_dir()

    for filename in BOOK_TSV_FILES:
        file_path = data_dir / filename
        if not file_path.exists():
            continue

        with file_path.open("r", encoding="utf-8") as handle:
            reader = csv.DictReader(handle, delimiter="\t")
            for row in reader:
                pgn_line = (row.get("pgn") or "").strip()
                if not pgn_line:
                    continue

                board = chess.Board()
                for san in _extract_san_moves(pgn_line):
                    try:
                        move = board.parse_san(san)
                    except ValueError:
                        break

                    parent_fen = normalize_fen(board.fen())
                    uci = move.uci()
                    book_index.setdefault(parent_fen, {}).setdefault(uci, san)
                    board.push(move)

    return book_index


@lru_cache(maxsize=1)
def load_common_book_index() -> dict[str, dict[str, str]]:
    return _build_book_index()


def get_common_book_moves(fen: str) -> list[dict[str, str | None]]:
    moves = load_common_book_index().get(normalize_fen(fen), {})
    return [{"uci": uci, "san": san} for uci, san in sorted(moves.items())]


def is_common_book_move(
    fen: str, move_uci: str | None, move_san: str | None = None
) -> bool:
    moves = load_common_book_index().get(normalize_fen(fen), {})
    if move_uci and move_uci in moves:
        return True
    if move_san and move_san in moves.values():
        return True
    return False
