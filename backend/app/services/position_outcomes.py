"""FEN-local terminal facts. Repetition and clock-dependent draws are excluded."""

import chess
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.position_outcome import PositionOutcome
from app.services.game_ingest import _insert_for_session


def terminal_outcome(fen: str) -> tuple[int, str] | None:
    try:
        board = chess.Board(fen if len(fen.split()) == 6 else f"{fen} 0 1")
    except ValueError:
        return None
    if not board.is_valid() or any(board.legal_moves):
        return None
    if board.is_check():
        return (-1 if board.turn == chess.WHITE else 1), "checkmate"
    return 0, "stalemate"


async def store_position_outcomes(session: AsyncSession, positions: list[tuple[int, str]]) -> int:
    rows = []
    for position_id, fen in dict(positions).items():
        outcome = terminal_outcome(fen)
        if outcome is not None:
            rows.append({"position_id": position_id, "white_result": outcome[0], "reason": outcome[1]})
    if not rows:
        return 0
    inserted = await session.scalars(
        _insert_for_session(session)(PositionOutcome).values(rows)
        .on_conflict_do_nothing(index_elements=["position_id"])
        .returning(PositionOutcome.position_id)
    )
    return len(inserted.all())
