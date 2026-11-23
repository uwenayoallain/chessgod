"""Quiz the player on their own openings against the master book.

The positions are the player's: every one they reached with the move theirs
in the first `MAX_QUIZ_PLY` plies, in the colour and time controls asked for.
Only positions masters have played often enough to have a book are asked,
and a position where the player's usual move is *not* a book move comes
first — that is where the repertoire leaks. The rest follow by how often the
player reaches them, so the lines they actually play are rehearsed too.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_move import PositionMove
from app.services.game_scope import time_class_condition

MAX_QUIZ_PLY = 20
# A position needs this many master games before its book means anything…
MIN_MASTER_GAMES = 100
# …and a move needs this share of them, and this many, to count as book.
BOOK_MIN_SHARE = 0.03
BOOK_MIN_GAMES = 10
# How many of the player's most-reached positions are considered at all.
_CANDIDATE_POSITIONS = 400


@dataclass(frozen=True)
class QuizMove:
    uci: str
    san: str
    count: int
    share: float


@dataclass(frozen=True)
class QuizPosition:
    position_id: int
    fen: str
    ply: int
    side_to_move: str
    occurrences: int
    opening_name: str | None
    last_move_uci: str | None
    user_moves: list[QuizMove]
    book_moves: list[QuizMove]
    usual_move_in_book: bool


async def build_opening_quiz(
    session: AsyncSession,
    *,
    username: str,
    color: str = "both",
    time_class: str | None = None,
    limit: int = 12,
) -> list[QuizPosition]:
    reached = aliased(GamePosition)
    played = aliased(GamePosition)
    # The player's turn: even plies as White (the start is ply 0), odd as Black.
    their_turn = or_(
        and_(Game.user_color == "white", reached.ply % 2 == 0),
        and_(Game.user_color == "black", reached.ply % 2 == 1),
    )
    filters = [
        Game.username == username,
        reached.ply > 0,  # the first move is a preference, not a question
        reached.ply < MAX_QUIZ_PLY,
        their_turn,
        Position.master_total >= MIN_MASTER_GAMES,
    ]
    if color != "both":
        filters.append(Game.user_color == color)
    time_filter = time_class_condition(Game.time_class, time_class)
    if time_filter is not None:
        filters.append(time_filter)

    rows = (await session.execute(
        select(
            reached.position_id,
            reached.ply,
            reached.move_uci,
            played.move_uci,
            played.move_san,
            func.count(),
        )
        .select_from(Game)
        .join(reached, reached.game_id == Game.id)
        .join(played, and_(played.game_id == Game.id, played.ply == reached.ply + 1))
        .join(Position, Position.id == reached.position_id)
        .where(*filters)
        .group_by(
            reached.position_id, reached.ply, reached.move_uci, played.move_uci, played.move_san
        )
    )).all()
    if not rows:
        return []

    user_moves: dict[int, Counter[tuple[str, str]]] = defaultdict(Counter)
    last_moves: dict[int, Counter[str]] = defaultdict(Counter)
    plies: dict[int, Counter[int]] = defaultdict(Counter)
    for position_id, ply, last_uci, uci, san, count in rows:
        if not uci:
            continue
        user_moves[position_id][(uci, san or uci)] += count
        if last_uci:
            last_moves[position_id][last_uci] += count
        plies[position_id][ply] += count

    ranked = sorted(user_moves, key=lambda pid: -sum(user_moves[pid].values()))
    ranked = ranked[:_CANDIDATE_POSITIONS]

    positions = {
        position.id: position
        for position in (await session.execute(
            select(Position).where(Position.id.in_(ranked))
        )).scalars()
    }
    master_rows = (await session.execute(
        select(
            PositionMove.from_position_id,
            PositionMove.move_uci,
            PositionMove.move_san,
            PositionMove.master_game_count,
        )
        .where(PositionMove.from_position_id.in_(ranked), PositionMove.master_game_count > 0)
    )).all()
    master: dict[int, list[tuple[str, str, int]]] = defaultdict(list)
    for position_id, uci, san, games in master_rows:
        master[position_id].append((uci, san, int(games)))

    quiz: list[QuizPosition] = []
    for position_id in ranked:
        position = positions.get(position_id)
        moves = master.get(position_id)
        if position is None or not moves:
            continue
        total = sum(games for _, _, games in moves)
        book = sorted(
            (
                QuizMove(uci=uci, san=san, count=games, share=round(games / total, 4))
                for uci, san, games in moves
                if games >= BOOK_MIN_GAMES and games / total >= BOOK_MIN_SHARE
            ),
            key=lambda move: -move.count,
        )
        if not book:
            continue
        occurrences = sum(user_moves[position_id].values())
        mine = [
            QuizMove(uci=uci, san=san, count=count, share=round(count / occurrences, 4))
            for (uci, san), count in user_moves[position_id].most_common()
        ]
        book_ucis = {move.uci for move in book}
        quiz.append(QuizPosition(
            position_id=position_id,
            fen=position.fen,
            ply=plies[position_id].most_common(1)[0][0],
            side_to_move="white" if position.fen.split()[1] == "w" else "black",
            occurrences=occurrences,
            opening_name=position.master_opening_name,
            last_move_uci=(last_moves[position_id].most_common(1) or [(None, 0)])[0][0],
            user_moves=mine,
            book_moves=book,
            usual_move_in_book=mine[0].uci in book_ucis,
        ))

    # Leaks first, most-reached first within each group.
    quiz.sort(key=lambda item: (item.usual_move_in_book, -item.occurrences))
    return quiz[:limit]
