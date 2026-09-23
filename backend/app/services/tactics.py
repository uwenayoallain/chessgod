"""Deterministic tactical motif detection from a stored principal variation.

Every motif here is derived from board geometry that can be re-checked move by
move. Nothing is inferred from an evaluation number alone, so a drill card never
claims a fork, pin, or mate that the position does not actually contain.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass

import chess


MAX_PV_PLIES = 8

_PIECE_VALUE = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
    chess.KING: 100,
}

_PIECE_NAME = {
    chess.PAWN: "pawn",
    chess.KNIGHT: "knight",
    chess.BISHOP: "bishop",
    chess.ROOK: "rook",
    chess.QUEEN: "queen",
    chess.KING: "king",
}

_DIAGONALS = ((1, 1), (1, -1), (-1, 1), (-1, -1))
_ORTHOGONALS = ((1, 0), (-1, 0), (0, 1), (0, -1))
_SLIDER_DIRECTIONS = {
    chess.BISHOP: _DIAGONALS,
    chess.ROOK: _ORTHOGONALS,
    chess.QUEEN: _DIAGONALS + _ORTHOGONALS,
}

# Most specific first: a back-rank mate is reported as a mate, and a fork that
# also happens to pin something is reported as a fork.
MOTIF_PRIORITY = (
    "mate",
    "fork",
    "skewer",
    "pin",
    "back_rank",
    "removing_the_defender",
)


@dataclass(frozen=True)
class Motif:
    key: str
    label: str
    detail: str


@dataclass(frozen=True)
class _Step:
    board_before: chess.Board
    board_after: chess.Board
    move: chess.Move
    san: str


def _name(piece: chess.Piece) -> str:
    return _PIECE_NAME[piece.piece_type]


def _square(square: int) -> str:
    return chess.square_name(square)


def _as_full_fen(fen: str) -> str:
    fields = fen.split()
    if len(fields) == 4:
        return f"{fen} 0 1"
    return fen


def parse_pv(pv_uci: Sequence[str] | str | None) -> list[str]:
    if pv_uci is None:
        return []
    if isinstance(pv_uci, str):
        return pv_uci.split()
    return [str(item) for item in pv_uci]


def _walk(board: chess.Board, moves: Sequence[str], max_plies: int) -> list[_Step]:
    steps: list[_Step] = []
    current = board.copy(stack=False)
    for uci in moves[:max_plies]:
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            break
        if move not in current.legal_moves:
            break
        san = current.san(move)
        before = current.copy(stack=False)
        current.push(move)
        steps.append(_Step(before, current.copy(stack=False), move, san))
    return steps


def _enemy_pair_on_ray(
    board: chess.Board,
    from_square: int,
    piece_type: int,
    color: chess.Color,
) -> Iterator[tuple[int, chess.Piece, int, chess.Piece]]:
    """Yield the first two enemy pieces standing back to back on an empty ray."""

    directions = _SLIDER_DIRECTIONS.get(piece_type)
    if not directions:
        return
    start_file = chess.square_file(from_square)
    start_rank = chess.square_rank(from_square)
    for delta_file, delta_rank in directions:
        found: list[tuple[int, chess.Piece]] = []
        file_index = start_file + delta_file
        rank_index = start_rank + delta_rank
        while 0 <= file_index <= 7 and 0 <= rank_index <= 7 and len(found) < 2:
            square = chess.square(file_index, rank_index)
            piece = board.piece_at(square)
            if piece is not None:
                found.append((square, piece))
            file_index += delta_file
            rank_index += delta_rank
        if len(found) == 2 and all(piece.color != color for _, piece in found):
            (near_square, near), (far_square, far) = found
            yield near_square, near, far_square, far


def _detect_mate(step: _Step) -> list[Motif]:
    if not step.board_after.is_checkmate():
        return []
    return [
        Motif(
            key="mate",
            label="Forced mate",
            detail=f"{step.san} is checkmate.",
        )
    ]


def _detect_fork(step: _Step, mover: chess.Color) -> list[Motif]:
    board = step.board_after
    piece = board.piece_at(step.move.to_square)
    if piece is None or piece.color != mover:
        return []
    attacker_value = _PIECE_VALUE[piece.piece_type]
    targets: list[tuple[int, chess.Piece]] = []
    for square in board.attacks(step.move.to_square):
        target = board.piece_at(square)
        if target is None or target.color == mover or target.piece_type == chess.PAWN:
            continue
        if (
            target.piece_type == chess.KING
            or _PIECE_VALUE[target.piece_type] > attacker_value
            or not board.is_attacked_by(not mover, square)
        ):
            targets.append((square, target))
    if len(targets) < 2:
        return []
    hits_king = any(target.piece_type == chess.KING for _, target in targets)
    if not hits_king:
        # Only claim a fork when the forking piece is not simply hanging.
        attacked = board.is_attacked_by(not mover, step.move.to_square)
        defended = board.is_attacked_by(mover, step.move.to_square)
        if attacked and not defended:
            return []
    listed = " and ".join(
        f"the {_name(target)} on {_square(square)}" for square, target in sorted(targets)
    )
    return [
        Motif(
            key="fork",
            label="Fork",
            detail=f"{step.san} attacks {listed} at once.",
        )
    ]


def _detect_pin_or_skewer(step: _Step, mover: chess.Color) -> list[Motif]:
    board = step.board_after
    piece = board.piece_at(step.move.to_square)
    if piece is None or piece.color != mover:
        return []
    motifs: list[Motif] = []
    for near_square, near, far_square, far in _enemy_pair_on_ray(
        board, step.move.to_square, piece.piece_type, mover
    ):
        near_value = _PIECE_VALUE[near.piece_type]
        far_value = _PIECE_VALUE[far.piece_type]
        # Only claim the motif when both ends are worth naming: a pawn lined up in
        # front of a knight is geometry, not a tactic.
        is_skewer = near.piece_type == chess.KING or (near_value >= 5 and far_value >= 3)
        is_pin = near_value >= 3 and (far.piece_type == chess.KING or far_value >= 5)
        if is_skewer and (near.piece_type == chess.KING or near_value > far_value):
            motifs.append(
                Motif(
                    key="skewer",
                    label="Skewer",
                    detail=(
                        f"{step.san} lines up the {_name(near)} on {_square(near_square)} "
                        f"in front of the {_name(far)} on {_square(far_square)}."
                    ),
                )
            )
        elif is_pin and far_value > near_value:
            motifs.append(
                Motif(
                    key="pin",
                    label="Pin",
                    detail=(
                        f"{step.san} pins the {_name(near)} on {_square(near_square)} "
                        f"against the {_name(far)} on {_square(far_square)}."
                    ),
                )
            )
    return motifs


def _detect_back_rank(step: _Step, mover: chess.Color) -> list[Motif]:
    board = step.board_after
    piece = board.piece_at(step.move.to_square)
    if piece is None or piece.color != mover or piece.piece_type not in {chess.ROOK, chess.QUEEN}:
        return []
    enemy = not mover
    king_square = board.king(enemy)
    if king_square is None:
        return []
    back_rank = 7 if enemy == chess.BLACK else 0
    if chess.square_rank(king_square) != back_rank:
        return []
    if chess.square_rank(step.move.to_square) != back_rank:
        return []
    if king_square not in board.attacks(step.move.to_square):
        return []
    escape_rank = back_rank - 1 if enemy == chess.BLACK else back_rank + 1
    king_file = chess.square_file(king_square)
    for file_offset in (-1, 0, 1):
        file_index = king_file + file_offset
        if not 0 <= file_index <= 7:
            continue
        blocker = board.piece_at(chess.square(file_index, escape_rank))
        if blocker is None or blocker.color != enemy:
            return []
    return [
        Motif(
            key="back_rank",
            label="Back-rank threat",
            detail=(
                f"{step.san} checks the king on {_square(king_square)} along its own back rank, "
                "and every escape square in front of it is blocked by its own pieces."
            ),
        )
    ]


def _detect_removing_the_defender(
    steps: Sequence[_Step], index: int, mover: chess.Color
) -> list[Motif]:
    step = steps[index]
    if not step.board_before.is_capture(step.move):
        return []
    victim = step.board_before.piece_at(step.move.to_square)
    if victim is None:  # en passant leaves the captured pawn off the target square
        return []
    guarded: dict[int, chess.Piece] = {}
    for square in step.board_before.attacks(step.move.to_square):
        guarded_piece = step.board_before.piece_at(square)
        if (
            guarded_piece is not None
            and guarded_piece.color == victim.color
            and guarded_piece.piece_type != chess.PAWN
        ):
            guarded[square] = guarded_piece
    if not guarded:
        return []
    for later in steps[index + 1 :]:
        if later.board_before.turn != mover:
            continue
        target = guarded.get(later.move.to_square)
        if target is None or not later.board_before.is_capture(later.move):
            continue
        taken = later.board_before.piece_at(later.move.to_square)
        if taken is None or taken.color != victim.color or taken.piece_type != target.piece_type:
            continue
        return [
            Motif(
                key="removing_the_defender",
                label="Removing the defender",
                detail=(
                    f"{step.san} takes the {_name(victim)} that guarded "
                    f"{_square(later.move.to_square)}, and the line then wins the "
                    f"{_name(taken)} there with {later.san}."
                ),
            )
        ]
    return []


def detect_motifs(
    fen: str,
    pv_uci: Sequence[str] | str | None,
    *,
    mover: chess.Color,
    max_plies: int = MAX_PV_PLIES,
) -> list[Motif]:
    """Return the motifs `mover` executes in the principal variation from `fen`.

    Only moves played by `mover` are inspected, so the same helper describes both
    the line the player missed and the line the opponent used to punish them.
    """

    moves = parse_pv(pv_uci)
    if not moves:
        return []
    try:
        board = chess.Board(_as_full_fen(fen))
    except ValueError:
        return []
    steps = _walk(board, moves, max_plies)
    if not steps:
        return []

    found: dict[str, Motif] = {}
    for index, step in enumerate(steps):
        if step.board_before.turn != mover:
            continue
        candidates = [
            *_detect_mate(step),
            *_detect_fork(step, mover),
            *_detect_pin_or_skewer(step, mover),
            *_detect_back_rank(step, mover),
            *_detect_removing_the_defender(steps, index, mover),
        ]
        for motif in candidates:
            found.setdefault(motif.key, motif)
    return [found[key] for key in MOTIF_PRIORITY if key in found]
