"""Opening Rush, and checking recent games against the repertoire.

Both read the served repertoire rather than rebuilding their own idea of it,
so a move the course teaches is exactly the move they ask for or look for.
"""

from __future__ import annotations

import random
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.training import LineMoveProgress
from app.services.repertoire_builder import MAX_PLY

# A Rush ends at the third wrong answer.
RUSH_LIVES = 3
RUSH_QUESTIONS = 80
# Plies per difficulty band: early moves first, deeper ones as the run goes on.
RUSH_BAND_PLIES = 4
# The first move of each side is a preference, not a question.
RUSH_MIN_PLY = 3
CHECK_GAMES_PER_COLOR = 20


@dataclass(frozen=True)
class Expected:
    uci: str
    san: str
    line_id: str
    line_name: str | None
    color: str


def expected_moves(repertoires: list[dict]) -> dict[str, Expected]:
    """The repertoire's move at each of the player's positions, by FEN.

    Unchecked steps are left out: a move the engine never vetted (no MultiPV
    search of its position yet) is only "the move you happened to play", and
    the check and the weekly challenge must not preach it over the move the
    player chose on the day — the game move may well be the better one. The
    repertoire simply runs out where the evidence does, and the step returns
    once `make repertoire-engine` (or the course's "Check now") has searched it.
    """
    moves: dict[str, Expected] = {}
    for repertoire in repertoires:
        for line in repertoire["lines"]:
            for step in line["moves"]:
                if step["side"] == "you" and step["fen"] not in moves and step.get("checked", True):
                    moves[step["fen"]] = Expected(
                        uci=step["uci"], san=step["san"], line_id=line["id"],
                        line_name=line.get("name"), color=repertoire["color"],
                    )
    return moves


def rush_questions(repertoires: list[dict], *, seed: int | None = None,
                   limit: int = RUSH_QUESTIONS) -> list[dict]:
    """Every repertoire move once, easiest first, shuffled within each band."""
    seen: dict[str, dict] = {}
    for repertoire in repertoires:
        for line in repertoire["lines"]:
            previous = None
            for step in line["moves"]:
                # Unchecked moves are never quizzed, for the same reason
                # `expected_moves` leaves them out: the engine has not vetted
                # them, so a "wrong" answer might be the better move.
                if (
                    step["side"] == "you"
                    and step["ply"] >= RUSH_MIN_PLY
                    and step["fen"] not in seen
                    and step.get("checked", True)
                ):
                    seen[step["fen"]] = {
                        "fen": step["fen"],
                        "last_move_uci": previous["uci"] if previous else None,
                        "side_to_move": "white" if step["fen"].split(" ")[1] == "w" else "black",
                        "color": repertoire["color"],
                        "ply": step["ply"],
                        "line_name": line.get("name"),
                        # The answer travels too: the board has to take back a
                        # wrong move and show the right one without a round trip.
                        "answer_uci": step["uci"],
                        "answer_san": step["san"],
                        "changed": step.get("status") == "change",
                    }
                previous = step
    rng = random.Random(seed)
    bands: defaultdict[int, list[dict]] = defaultdict(list)
    for question in seen.values():
        bands[(question["ply"] - RUSH_MIN_PLY) // RUSH_BAND_PLIES].append(question)
    ordered: list[dict] = []
    for band in sorted(bands):
        rng.shuffle(bands[band])
        ordered.extend(bands[band])
    return ordered[:limit]


def score_rush(answers: list[tuple[str, str]], expected: dict[str, Expected]) -> dict:
    """Score a run from the moves played, stopping where the third miss ended it."""
    correct = 0
    misses: list[str] = []
    for fen, played in answers:
        answer = expected.get(fen)
        if answer is None:
            continue
        if played == answer.uci:
            correct += 1
        else:
            misses.append(fen)
            if len(misses) >= RUSH_LIVES:
                break
    return {"score": correct, "missed": misses}


async def requeue(session: AsyncSession, username: str, keys: list[tuple[str, str]],
                  *, before: dict[tuple[str, str], datetime] | None = None,
                  now: datetime | None = None) -> int:
    """Bring learned moves the player just got wrong back to the front of the queue.

    `before`, when given, holds the moment each miss happened: a move reviewed
    since is left alone, because the review already dealt with it.
    """
    if not keys:
        return 0
    now = now or datetime.now(UTC)
    rows = (
        await session.execute(
            select(LineMoveProgress).where(
                LineMoveProgress.username == username,
                LineMoveProgress.fen.in_([fen for fen, _ in keys]),
            )
        )
    ).scalars().all()
    wanted = set(keys)
    changed = 0
    for row in rows:
        key = (row.fen, row.move_uci)
        if key not in wanted or (row.level or 0) < 1:
            continue
        reviewed = row.last_reviewed_at
        if reviewed is not None and reviewed.tzinfo is None:
            reviewed = reviewed.replace(tzinfo=UTC)
        if before and reviewed is not None and key in before and reviewed >= before[key]:
            continue
        due = row.due_at if row.due_at.tzinfo else row.due_at.replace(tzinfo=UTC)
        if row.level == 1 and due <= now:
            continue
        row.level = 1
        row.due_at = now
        changed += 1
    return changed


def first_departure(plies: dict[int, tuple], expected: dict[str, Expected], color: str
                    ) -> tuple[bool, tuple[int, str, Expected] | None]:
    """Whether a game met the repertoire at all, and the first move that left it.

    `plies` maps each ply to (uci, san, fen after it). Returns (met, departure),
    where a departure is the ply, the FEN before it and the repertoire's move.
    """
    player_parity = 1 if color == "white" else 0
    met = False
    for ply in sorted(plies):
        # The first move is a preference, as in the Rush, not a lapse.
        if ply < RUSH_MIN_PLY or ply % 2 != player_parity or ply - 1 not in plies:
            continue
        uci = plies[ply][0]
        fen = plies[ply - 1][2]
        answer = expected.get(fen)
        if answer is None or answer.color != color or not uci:
            continue
        met = True
        if uci != answer.uci:
            return True, (ply, fen, answer)
    return met, None


async def opening_plies(session: AsyncSession, game_ids: list[int]) -> dict[int, dict[int, tuple]]:
    """Each game's opening moves: ply -> (uci, san, fen after it)."""
    if not game_ids:
        return {}
    rows = (
        await session.execute(
            select(GamePosition.game_id, GamePosition.ply, GamePosition.move_uci,
                   GamePosition.move_san, Position.fen)
            .join(Position, Position.id == GamePosition.position_id)
            .where(GamePosition.game_id.in_(game_ids), GamePosition.ply <= MAX_PLY)
        )
    ).all()
    by_game: dict[int, dict[int, tuple]] = defaultdict(dict)
    for game_id, ply, uci, san, fen in rows:
        by_game[game_id][ply] = (uci, san, fen)
    return by_game


async def check_recent_games(
    session: AsyncSession, username: str, repertoires: list[dict], *,
    per_color: int = CHECK_GAMES_PER_COLOR, now: datetime | None = None,
) -> dict:
    """Where the player's latest games left the repertoire, and what that sends back to review."""
    expected = expected_moves(repertoires)
    deviations: list[dict] = []
    checked = followed = 0
    misses: dict[tuple[str, str], datetime] = {}
    for repertoire in repertoires:
        color = repertoire["color"]
        games = (
            await session.execute(
                select(Game.id, Game.chesscom_game_url, Game.played_at, Game.user_result, Game.opening_name)
                .where(
                    Game.username == username,
                    Game.user_color == color,
                    Game.time_class.in_(("rapid", "blitz")),
                )
                .order_by(Game.played_at.desc())
                .limit(per_color)
            )
        ).all()
        by_game = await opening_plies(session, [game.id for game in games])
        for game in games:
            plies = by_game.get(game.id, {})
            met, departure = first_departure(plies, expected, color)
            if not met:
                continue
            checked += 1
            if departure is None:
                followed += 1
                continue
            ply, fen, answer = departure
            uci, san, _ = plies[ply]
            played_at = game.played_at if game.played_at.tzinfo else game.played_at.replace(tzinfo=UTC)
            deviations.append({
                "game_id": game.id,
                "url": game.chesscom_game_url,
                "played_at": played_at.isoformat(),
                "result": game.user_result,
                "color": color,
                "fen": fen,
                "ply": ply,
                "played_san": san or uci,
                "expected_san": answer.san,
                "expected_uci": answer.uci,
                "line_id": answer.line_id,
                "line_name": answer.line_name or game.opening_name,
            })
            key = (fen, answer.uci)
            misses[key] = max(misses.get(key, played_at), played_at)
    requeued = await requeue(session, username, list(misses), before=misses, now=now)
    deviations.sort(key=lambda item: item["played_at"], reverse=True)
    return {
        "games_checked": checked,
        "games_followed": followed,
        "deviations": deviations[:12],
        "requeued": requeued,
    }
