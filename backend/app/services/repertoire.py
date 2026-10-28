from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.repertoire_mark import RepertoireMark
from app.services.cache import get_shared_cache
from app.schemas.theory import RepertoireMarkIn, RepertoireMarkOut, RepertoireNodeOut, RepertoireTreeOut, TheoryMove


NORMAL_STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"

# How many of the user's own choices to branch at each user-to-move node. Opponent
# replies are followed single-file (their most-played answer) so the tree stays a
# study of *the user's* decisions, not a full game tree.
_USER_TOP_K = 3
_DEFAULT_MAX_DEPTH = 12
# A node is a "hole" (no settled answer) when the user's most-played move there
# accounts for less than this share of games at that node.
_HOLE_DOMINANCE = 0.6


@dataclass
class _Edge:
    san: str
    child_fen: str
    games: int = 0
    wins: int = 0


@dataclass
class _Node:
    # keyed by move_uci -> edge stats; built once from a single query
    edges: dict[str, _Edge] = field(default_factory=dict)
    games: int = 0
    wins: int = 0


def _side_to_move(fen: str) -> str:
    parts = fen.split(" ")
    return "white" if len(parts) < 2 or parts[1] == "w" else "black"


# The single graph query still scans ~26 plies of every game of the user
# (~1.5s at thousands of games), and the tree only changes on import or when a
# mark is toggled — cache per (user, color, depth) and invalidate on mark writes.
_REPERTOIRE_TTL_SECONDS = 600.0  # imports and marks clear it


async def invalidate_repertoire_cache(username: str, color: str) -> None:
    await get_shared_cache().delete_prefix(f"repertoire:{username}:{color}:")


async def derive_repertoire(
    session: AsyncSession,
    username: str,
    color: str,
    max_depth: int = _DEFAULT_MAX_DEPTH,
) -> RepertoireTreeOut:
    cache = get_shared_cache()
    cache_key = f"repertoire:{username}:{color}:{max_depth}"
    cache_key = await cache.versioned_key(cache_key)
    cached = await cache.get_json(cache_key)
    if cached is not None:
        return RepertoireTreeOut.model_validate(cached)

    marks_result = await session.execute(
        select(RepertoireMark).where(RepertoireMark.username == username, RepertoireMark.color == color)
    )
    marked_fens = {mark.fen for mark in marks_result.scalars().all()}

    # ONE query: every (game, ply) the user played, in order. The move on a
    # game_position is the move made *from* that position, so consecutive plies
    # within a game give parent_fen --move--> child_fen edges. Build the move
    # graph in memory and walk it (no per-node round trips like the old version).
    # Only the first max_depth plies matter for the tree; capping plies turns a
    # ~200k-row scan (full games) into a ~24-rows-per-game scan.
    rows = await session.execute(
        select(
            GamePosition.game_id,
            GamePosition.ply,
            Position.fen,
            GamePosition.move_uci,
            GamePosition.move_san,
            Game.user_result,
        )
        .select_from(GamePosition)
        .join(Game, Game.id == GamePosition.game_id)
        .join(Position, Position.id == GamePosition.position_id)
        .where(
            Game.username == username,
            Game.user_color == color,
            GamePosition.ply <= max_depth + 1,
        )
        .order_by(GamePosition.game_id.asc(), GamePosition.ply.asc())
    )

    graph: dict[str, _Node] = defaultdict(_Node)
    current_game: int | None = None
    sequence: list[tuple[str, str | None, str | None]] = []  # (fen, move_uci, move_san)
    current_result: str | None = None

    def flush_game(seq: list[tuple[str, str | None, str | None]], result: str | None) -> None:
        # move_uci/move_san on a game_position is the move that LED TO that
        # position, so the edge parent(ply i) -> child(ply i+1) carries the
        # child row's move, not the parent's.
        won = result == "win"
        for i in range(len(seq) - 1):
            parent_fen = seq[i][0]
            child_fen, move_uci, move_san = seq[i + 1]
            if not move_uci:
                continue
            node = graph[parent_fen]
            node.games += 1
            node.wins += 1 if won else 0
            edge = node.edges.get(move_uci)
            if edge is None:
                edge = _Edge(san=move_san or move_uci, child_fen=child_fen)
                node.edges[move_uci] = edge
            edge.games += 1
            edge.wins += 1 if won else 0

    for game_id, ply, fen, move_uci, move_san, user_result in rows.all():
        if game_id != current_game:
            if current_game is not None:
                flush_game(sequence, current_result)
            current_game = game_id
            sequence = []
            current_result = user_result
        sequence.append((fen, move_uci, move_san))
    if current_game is not None:
        flush_game(sequence, current_result)

    # Openings transpose heavily: the same FEN is reached by many move orders, so a
    # naive recursion re-expands identical subtrees combinatorially (this made the
    # endpoint take ~40s and emit a huge duplicated tree). Memoise the canonical
    # subtree per (fen, depth); the parent-specific `move` is grafted on per call.
    memo: dict[tuple[str, int], RepertoireNodeOut] = {}

    def build(fen: str, depth: int, move: TheoryMove | None) -> RepertoireNodeOut:
        key = (fen, depth)
        cached = memo.get(key)
        if cached is not None:
            return cached if move is None else cached.model_copy(update={"move": move})

        node = graph.get(fen)
        is_user_turn = _side_to_move(fen) == color
        out = RepertoireNodeOut(
            fen=fen,
            move=None,
            game_count=node.games if node else 0,
            win_rate=round(node.wins / node.games, 4) if node and node.games else 0.0,
            marked=fen in marked_fens,
            is_user_turn=is_user_turn,
        )
        if node is not None and depth < max_depth and node.edges:
            ordered = sorted(node.edges.items(), key=lambda kv: (-kv[1].games, kv[1].san))
            total = sum(edge.games for _, edge in ordered)
            if is_user_turn:
                top = ordered[:_USER_TOP_K]
                if total and ordered[0][1].games / total < _HOLE_DOMINANCE and len(ordered) > 1:
                    out.is_hole = True
            else:
                # follow the opponent's most-played reply only
                top = ordered[:1]

            for move_uci, edge in top:
                out.children.append(
                    build(
                        edge.child_fen,
                        depth + 1,
                        TheoryMove(
                            san=edge.san,
                            uci=move_uci,
                            game_count=edge.games,
                            win_rate=round(edge.wins / edge.games, 4) if edge.games else 0.0,
                        ),
                    )
                )

        memo[key] = out
        return out if move is None else out.model_copy(update={"move": move})

    tree = RepertoireTreeOut(
        username=username,
        color=color,
        root=build(NORMAL_STARTING_FEN, 0, None),
    )
    await cache.set_json(
        cache_key, tree.model_dump(mode="json"), ttl_seconds=_REPERTOIRE_TTL_SECONDS
    )
    return tree


async def upsert_repertoire_mark(
    session: AsyncSession,
    payload: RepertoireMarkIn,
) -> RepertoireMarkOut:
    existing = await session.scalar(
        select(RepertoireMark).where(
            RepertoireMark.username == payload.username,
            RepertoireMark.fen == payload.fen,
            RepertoireMark.color == payload.color,
        )
    )
    if existing is None:
        existing = RepertoireMark(
            username=payload.username,
            fen=payload.fen,
            color=payload.color,
            intended_move_uci=payload.intended_move_uci,
            intended_move_san=payload.intended_move_san,
            family_id=payload.family_id,
            note=payload.note,
        )
        session.add(existing)
        await session.flush()
    else:
        existing.intended_move_uci = payload.intended_move_uci
        existing.intended_move_san = payload.intended_move_san
        existing.family_id = payload.family_id
        existing.note = payload.note

    await invalidate_repertoire_cache(payload.username, payload.color)
    return RepertoireMarkOut(
        id=existing.id,
        username=existing.username,
        fen=existing.fen,
        color=existing.color,
        intended_move_uci=existing.intended_move_uci,
        intended_move_san=existing.intended_move_san,
        family_id=existing.family_id,
        note=existing.note,
        marked_at=existing.marked_at,
    )


async def delete_repertoire_mark(
    session: AsyncSession,
    *,
    username: str,
    fen: str,
    color: str,
) -> None:
    await session.execute(
        delete(RepertoireMark).where(
            RepertoireMark.username == username,
            RepertoireMark.fen == fen,
            RepertoireMark.color == color,
        )
    )
    await invalidate_repertoire_cache(username, color)
