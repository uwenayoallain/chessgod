from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.external_sync_state import ExternalSyncState
from app.models.position import Position
from app.models.position_move import PositionMove
from app.services.observability import get_observability_store
from app.services.pgn_parser import ParsedGame

DEFAULT_CANDIDATE_POSITION_LIMIT = 1_000


class LichessExplorerClient:
    def __init__(self, http_client: httpx.AsyncClient):
        self.client = http_client
        self.base_url = settings.lichess_explorer_url.rstrip("/")
        self.api_token = settings.lichess_api_token
        self.request_delay = settings.lichess_request_delay
        self._request_lock = asyncio.Lock()
        self._last_request_at: float | None = None

    async def get_master_stats(self, fen: str) -> dict:
        headers: dict[str, str] = {}
        if self.api_token:
            headers["Authorization"] = f"Bearer {self.api_token}"

        store = get_observability_store()
        started = time.perf_counter()
        status_code: int | None = None
        ok = False
        try:
            async with self._request_lock:
                if self.request_delay > 0 and self._last_request_at is not None:
                    elapsed = time.monotonic() - self._last_request_at
                    if elapsed < self.request_delay:
                        await asyncio.sleep(self.request_delay - elapsed)

                response = await self.client.get(
                    f"{self.base_url}/masters",
                    params={"fen": fen, "moves": 12, "topGames": 0, "recentGames": 0},
                    headers=headers or None,
                )
                self._last_request_at = time.monotonic()

            status_code = response.status_code
            response.raise_for_status()
            ok = True
            return response.json()
        finally:
            duration_ms = (time.perf_counter() - started) * 1000.0
            store.record_external_call(
                service="lichess",
                operation="masters",
                duration_ms=duration_ms,
                ok=ok,
                status_code=status_code,
            )


async def load_lichess_sync_state(session: AsyncSession) -> dict[str, str | int | None] | None:
    state = await session.get(ExternalSyncState, "lichess_opening_explorer")
    if state is None:
        return None
    cooldown_until = state.cooldown_until
    if cooldown_until is not None and cooldown_until.tzinfo is None:
        cooldown_until = cooldown_until.replace(tzinfo=UTC)
    updated_at = state.updated_at
    if updated_at is not None and updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=UTC)
    return {
        "provider": state.provider,
        "cooldown_until": cooldown_until.isoformat() if cooldown_until else None,
        "last_status_code": state.last_status_code,
        "last_error": state.last_error,
        "updated_at": updated_at.isoformat() if updated_at else None,
    }


def total_games_from_counts(white_wins: int, draws: int, black_wins: int) -> int:
    return white_wins + draws + black_wins


def classify_deviation_severity(user_win_rate: float, master_win_rate: float) -> str:
    delta = abs(master_win_rate - user_win_rate)
    if delta < 0.05:
        return "minor"
    if delta <= 0.15:
        return "moderate"
    return "major"


def build_deviation(
    fen: str,
    user_moves: list[dict],
    master_moves: list[dict],
    eco: str | None,
    opening_name: str | None,
) -> dict | None:
    if not user_moves or not master_moves:
        return None

    user_top_move = user_moves[0]
    master_top_move = master_moves[0]
    if user_top_move["san"] == master_top_move["san"]:
        return None

    return {
        "fen": fen,
        "move_number": user_top_move["move_number"],
        "user_top_move": {
            "san": user_top_move["san"],
            "game_count": user_top_move["game_count"],
            "win_rate": user_top_move["win_rate"],
        },
        "master_top_move": {
            "san": master_top_move["san"],
            "game_count": master_top_move["game_count"],
            "win_rate": master_top_move["win_rate"],
        },
        "eco": eco,
        "opening_name": opening_name,
        "severity": classify_deviation_severity(user_top_move["win_rate"], master_top_move["win_rate"]),
    }


def build_seeded_deviation(
    fen: str,
    user_moves: list[dict],
    master_moves: list[dict],
    eco: str | None,
    opening_name: str | None,
) -> dict | None:
    if not user_moves or not master_moves:
        return None

    user_top_move = user_moves[0]
    master_uci_set = {move.get("uci") for move in master_moves if move.get("uci")}
    master_san_set = {move.get("san") for move in master_moves if move.get("san")}
    if user_top_move.get("uci") in master_uci_set or user_top_move["san"] in master_san_set:
        return None

    master_top_move = master_moves[0]
    return {
        "fen": fen,
        "move_number": user_top_move["move_number"],
        "user_top_move": {
            "san": user_top_move["san"],
            "game_count": user_top_move["game_count"],
            "win_rate": user_top_move["win_rate"],
        },
        "master_top_move": {
            "san": master_top_move["san"],
            "game_count": master_top_move["game_count"],
            "win_rate": master_top_move["win_rate"],
        },
        "eco": eco,
        "opening_name": opening_name,
        "severity": "moderate",
    }


def cache_is_stale(last_fetched: datetime | None, master_total: int | None = None) -> bool:
    if last_fetched is None:
        return True
    if last_fetched.tzinfo is None:
        last_fetched = last_fetched.replace(tzinfo=UTC)
    # A position fetched and found to have no master games stays that way: the
    # masters database grows by curation, not by play, so 86% of this library's
    # fetches came back empty and re-asking monthly would spend the whole quota
    # re-confirming nothing. Empty answers keep their own, much longer TTL.
    ttl_days = (
        settings.lichess_empty_ttl_days
        if master_total == 0
        else settings.lichess_cache_ttl_days
    )
    return datetime.now(UTC) - last_fetched > timedelta(days=ttl_days)


def master_data_state(position: Position, moves: list[PositionMove]) -> str:
    if position.master_fetched_at is not None:
        return "synced"
    if (
        position.master_eco is not None
        or position.master_opening_name is not None
        or any(move.master_game_count is not None for move in moves)
    ):
        return "seeded"
    return "missing"


async def load_position_by_fen(session: AsyncSession, fen: str) -> Position | None:
    result = await session.execute(select(Position).where(Position.fen == fen))
    return result.scalar_one_or_none()


async def load_moves_for_position(session: AsyncSession, position_id: int) -> list[PositionMove]:
    result = await session.execute(
        select(PositionMove)
        .where(PositionMove.from_position_id == position_id)
        .order_by(PositionMove.game_count.desc(), PositionMove.move_san.asc())
    )
    return list(result.scalars().all())


def serialize_user_move(move: PositionMove, color: str) -> dict:
    total_games = max(move.game_count, 1)
    win_count = move.white_wins if color == "white" else move.black_wins
    return {
        "san": move.move_san,
        "uci": move.move_uci,
        "game_count": move.game_count,
        "move_number": move.move_number,
        "win_rate": round(win_count / total_games, 4),
    }


def serialize_master_move(move: dict, color: str) -> dict:
    total_games = max(move["white"] + move["draws"] + move["black"], 1)
    win_count = move["white"] if color == "white" else move["black"]
    return {
        "san": move["san"],
        "uci": move.get("uci"),
        "game_count": total_games,
        "win_rate": round(win_count / total_games, 4),
    }


async def cache_master_stats(
    session: AsyncSession,
    position: Position,
    moves: list[PositionMove],
    master_data: dict,
) -> None:
    # Lichess sends `"opening": null` for a position with no named opening, and
    # a default only applies to a *missing* key -- `.get("opening", {})` hands
    # back None for every such position. Latent until the explorer started
    # answering at all: with the sync 401ing, no response ever reached here.
    opening = master_data.get("opening") or {}
    position.master_total = master_data.get("white", 0) + master_data.get("draws", 0) + master_data.get("black", 0)
    position.master_white = master_data.get("white")
    position.master_draws = master_data.get("draws")
    position.master_black = master_data.get("black")
    position.master_eco = opening.get("eco")
    position.master_opening_name = opening.get("name")
    position.master_fetched_at = datetime.now(UTC)

    move_map = {move.move_uci: move for move in moves}
    san_map = {move.move_san: move for move in moves}
    for master_move in master_data.get("moves") or []:
        move = move_map.get(master_move.get("uci")) or san_map.get(master_move.get("san"))
        if move is None:
            continue
        move.master_game_count = master_move.get("white", 0) + master_move.get("draws", 0) + master_move.get("black", 0)
        move.master_white_wins = master_move.get("white")
        move.master_draws = master_move.get("draws")
        move.master_black_wins = master_move.get("black")
        move.master_fetched_at = position.master_fetched_at

    await session.flush()


def build_local_master_data(position: Position, moves: list[PositionMove]) -> dict:
    return {
        "white": position.master_white or 0,
        "draws": position.master_draws or 0,
        "black": position.master_black or 0,
        "opening": {"eco": position.master_eco, "name": position.master_opening_name},
        "moves": [
            {
                "san": move.move_san,
                "uci": move.move_uci,
                "white": move.master_white_wins or 0,
                "draws": move.master_draws or 0,
                "black": move.master_black_wins or 0,
            }
            for move in moves
            if move.master_game_count is not None
        ],
    }


def get_local_master_data(position: Position, moves: list[PositionMove]) -> dict:
    if master_data_state(position, moves) == "missing":
        return {"white": 0, "draws": 0, "black": 0, "opening": {}, "moves": []}
    return build_local_master_data(position, moves)


async def refresh_master_data(
    session: AsyncSession,
    client: LichessExplorerClient,
    position: Position,
    moves: list[PositionMove],
) -> dict:
    master_data = await client.get_master_stats(position.fen)
    await cache_master_stats(session, position, moves, master_data)
    return master_data


async def get_or_fetch_master_data(
    session: AsyncSession,
    client: LichessExplorerClient,
    position: Position,
    moves: list[PositionMove],
) -> dict:
    state = master_data_state(position, moves)
    if state != "missing":
        return build_local_master_data(position, moves)

    return await refresh_master_data(session, client, position, moves)


async def load_candidate_positions(
    session: AsyncSession,
    color: str,
    min_games: int,
    limit: int = DEFAULT_CANDIDATE_POSITION_LIMIT,
) -> list[tuple[Position, list[PositionMove]]]:
    """Load a bounded, popularity-ordered candidate set for deviations.

    Materializing every qualifying position and interpolating all IDs into one
    ``IN`` query exceeded PostgreSQL's 32,767 bind-parameter limit on large
    imports. The deviations panel needs the most-played positions first, so a
    bounded top-N read keeps memory and parameter counts proportional to the
    requested result size.
    """

    is_white_move = color == "white"
    limit = max(1, min(limit, 5_000))
    position_result = await session.execute(
        select(Position)
        .where(
            Position.total_games >= min_games,
            select(PositionMove.id)
            .where(
                PositionMove.from_position_id == Position.id,
                PositionMove.is_white_move == is_white_move,
            )
            .exists(),
        )
        .order_by(Position.total_games.desc(), Position.id.asc())
        .limit(limit)
    )
    positions = list(position_result.scalars().all())
    if not positions:
        return []

    moves_result = await session.execute(
        select(PositionMove)
        .where(
            PositionMove.from_position_id.in_([p.id for p in positions]),
            PositionMove.is_white_move == is_white_move,
        )
        .order_by(PositionMove.game_count.desc(), PositionMove.move_san.asc())
    )
    moves_by_pos: dict[int, list[PositionMove]] = {}
    for move in moves_result.scalars().all():
        moves_by_pos.setdefault(move.from_position_id, []).append(move)

    candidates: list[tuple[Position, list[PositionMove]]] = []
    for position in positions:
        moves = moves_by_pos.get(position.id, [])
        if not moves:
            continue
        candidates.append((position, moves))
    return candidates


STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"

MAX_DEEP_LINE_DEPTH = 30


async def build_deep_training_line(
    session: AsyncSession,
    starting_fen: str = STARTING_FEN,
) -> list[dict]:
    training_moves: list[dict] = []
    current_fen = starting_fen
    ply = 0

    for _ in range(MAX_DEEP_LINE_DEPTH):
        position = await load_position_by_fen(session, current_fen)
        if position is None:
            break

        moves = await load_moves_for_position(session, position.id)
        if not moves:
            break

        master_data = get_local_master_data(position, moves)
        master_moves = master_data.get("moves", [])
        if not master_moves:
            break

        master_uci_set = {m.get("uci") for m in master_moves if m.get("uci")}
        master_san_set = {m.get("san") for m in master_moves if m.get("san")}

        best_move: PositionMove | None = None
        for pm in moves:
            if pm.move_uci in master_uci_set or pm.move_san in master_san_set:
                if best_move is None or (pm.master_game_count or 0) > (best_move.master_game_count or 0):
                    best_move = pm
                elif (pm.master_game_count or 0) == (best_move.master_game_count or 0) and pm.game_count > best_move.game_count:
                    best_move = pm

        if best_move is None:
            break

        to_position = await session.get(Position, best_move.to_position_id)
        if to_position is None:
            break

        ply += 1
        training_moves.append(
            {
                "ply": ply,
                "fen": current_fen,
                "san": best_move.move_san,
                "uci": best_move.move_uci,
                "resulting_fen": to_position.fen,
            }
        )
        current_fen = to_position.fen

    return training_moves


async def build_training_line_from_parsed_game(
    session: AsyncSession,
    parsed_game: ParsedGame,
) -> list[dict]:
    training_moves: list[dict] = []

    for index in range(1, len(parsed_game.positions)):
        previous = parsed_game.positions[index - 1]
        current = parsed_game.positions[index]
        position = await load_position_by_fen(session, previous.fen)
        if position is None:
            break

        moves = await load_moves_for_position(session, position.id)
        master_data = get_local_master_data(position, moves)
        matching_master_move = next(
            (
                move
                for move in master_data.get("moves", [])
                if move.get("uci") == current.move_uci or move.get("san") == current.move_san
            ),
            None,
        )
        if matching_master_move is None:
            break

        training_moves.append(
            {
                "ply": current.ply,
                "fen": previous.fen,
                "san": matching_master_move.get("san") or current.move_san,
                "uci": matching_master_move.get("uci") or current.move_uci,
                "resulting_fen": current.fen,
            }
        )

    return training_moves
