from __future__ import annotations


def normalize_fen(fen: str) -> str:
    parts = fen.split(" ")
    if len(parts) <= 4:
        return fen
    return " ".join(parts[:4])
