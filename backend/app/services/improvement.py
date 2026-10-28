from __future__ import annotations

import asyncio
import time
import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from math import sqrt
from typing import Any

import chess
from sqlalchemy import DateTime, Integer, Text, bindparam, case, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.engine_contract import ENGINE_NAME, ENGINE_VERSION, MAX_PAIR_DEPTH_GAP, MIN_TRUSTED_DEPTH
from app.models.analysis import AnalysisResult
from app.models.drill_progress import DrillAttempt, DrillProgress
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.sparring import SparringGame, SparringMistake
from app.schemas.improvement import (
    DrillAttemptIn,
    DrillFollowUpOut,
    DrillIntentOut,
    MotifOut,
    DrillAttemptOut,
    DrillCardOut,
    ImprovementPlanOut,
    ImprovementSummaryOut,
    OpeningPriorityOut,
    OutcomeInsightOut,
    PatternTrendOut,
    PhaseCoverageOut,
    RetentionOut,
    TimeClassResultOut,
    WeeklyPrescriptionOut,
    PatternSummaryOut,
)
from app.services.cache import get_shared_cache
from app.services.game_scope import (
    DEFAULT_MIN_USER_RATING,
    RAPID_BLITZ,
    time_class_condition,
    user_rating_condition,
)
from app.services.mistakes import classify_engine_drop
from app.services.tactics import Motif, detect_motifs, parse_pv


DEFAULT_TIME_CLASS = RAPID_BLITZ
# Bump when the cached candidate payload gains fields, so a warm cache from an
# older build is never replayed into the newer plan builder.
_CANDIDATE_CACHE_VERSION = 16
_CANDIDATE_CACHE_SECONDS = 120.0
_CANDIDATE_SCAN_LIMIT = 1_000
_ACCEPTANCE_BAND_CP = 30
# A failure mode seen in this many different positions is a way of thinking, not
# an accident. Below it, a repeat in the same position is still worth drilling,
# but a single occurrence is a one-off and must not steer the weekly focus.
_HABIT_MIN_POSITIONS = 3
# Below this many analyzed decisions the corpus is too thin to steer study away
# from general improvement work.
_MIN_ANALYSED_DECISIONS = 500
# A phase holding more than this share of the evidence, while another holds less
# than the blind share, means the ranking describes one part of the game only.
_PHASE_SKEW_SHARE = 0.70
_PHASE_BLIND_SHARE = 0.10
# A training set is sized by the time it takes, not by a round number of cards.
# A direction is only reported when the pattern itself, and the window carrying the
# claim, have enough occurrences to mean anything.
_TREND_MIN_PATTERN_SAMPLES = 6
_TREND_MIN_WINDOW_OCCURRENCES = 3
_SESSION_SECONDS = 600
_SINGLE_MOVE_SECONDS = 40
_TWO_MOVE_SECONDS = 60


async def invalidate_improvement_caches(username: str, *, include_queue_counts: bool = True) -> None:
    """Invalidate every user-scoped input to the improvement plan.

    `include_queue_counts=False` keeps the analysis queue's coverage counts
    (`coverage:v3`). They only label progress and expire in a minute anyway,
    and rebuilding them scans every decision the player has (~270ms); dropping
    them on every evaluation upload — the crawler uploads about every forty
    seconds — made each crawler batch pay that scan. A new import still drops
    them, because it changes what there is to count.
    """

    cache = get_shared_cache()
    prefixes = [
        f"improvement:candidates:v{_CANDIDATE_CACHE_VERSION}:{username}:",
        f"improvement:coverage:v7:{username}:",
        f"improvement:trends:v8:{username}:",
        f"improvement:context:{username}:",
        f"mistakes:v7:{username}:",
        # The served plan (routers/improvement.py): stale-while-revalidate, so
        # this marks it stale rather than making the next read wait.
        f"improvement:plan:{username}:",
        # Where the player's points go (routers/improvement.py), served the same way.
        f"improvement:losses:{username}:",
        # The training repertoire (routers/training.py): its choices read evaluations.
        f"improvement:repertoire:{username}:",
        # Blunder Check's pool of the player's own big mistakes (routers/training.py).
        f"improvement:threats:{username}:",
        # Whether training is working (routers/training.py): new evidence moves it.
        f"improvement:progress:{username}:",
        f"improvement:clock:{username}:",
        # Over-the-board habits (routers/training.py): read from evaluations too.
        f"improvement:habits:{username}:",
    ]
    if include_queue_counts:
        prefixes.append(f"coverage:v3:{username}:")
        # The analysis queue's pool of decision pairs (routers/games.py): an
        # import adds decisions, an upload only resolves ones it already has.
        prefixes.append(f"queue-pool:v2:{username}:")
    await asyncio.gather(
        *(cache.delete_prefix(prefix, versioned_only=True) for prefix in prefixes)
    )


async def invalidate_improvement_caches_for_positions(
    session: AsyncSession, position_ids: set[int]
) -> set[str]:
    """Invalidate only users whose imported games contain changed positions."""

    if not position_ids:
        return set()
    affected_user_rows = await session.execute(
        select(Game.username)
        .join(GamePosition, GamePosition.game_id == Game.id)
        .where(GamePosition.position_id.in_(position_ids))
        .distinct()
    )
    usernames = {str(username) for username in affected_user_rows.scalars()}
    await asyncio.gather(*(_invalidate_for_upload(name) for name in usernames))
    return usernames


# The crawler uploads about every forty seconds, and each upload dropped every
# evidence cache the player has. The warmup then rebuilt them on nearly every
# pass (13.7s a pass, measured, while somebody used the app) — Postgres work
# that competes with the person it is warming for. Uploads now invalidate at
# most once per interval per player; one arriving inside it schedules a single
# trailing invalidation, so the newest evidence still lands within the interval.
_UPLOAD_INVALIDATION_INTERVAL_SECONDS = 120.0
_last_upload_invalidation: dict[str, float] = {}
_pending_upload_invalidation: dict[str, asyncio.Task] = {}


async def _invalidate_for_upload(username: str) -> None:
    key = username.lower()
    now = time.monotonic()
    wait = _last_upload_invalidation.get(key, -_UPLOAD_INVALIDATION_INTERVAL_SECONDS) + (
        _UPLOAD_INVALIDATION_INTERVAL_SECONDS - now
    )
    if wait <= 0:
        _last_upload_invalidation[key] = now
        await invalidate_improvement_caches(username, include_queue_counts=False)
        return
    pending = _pending_upload_invalidation.get(key)
    if pending is not None and not pending.done():
        return

    async def trailing() -> None:
        await asyncio.sleep(wait)
        _last_upload_invalidation[key] = time.monotonic()
        await invalidate_improvement_caches(username, include_queue_counts=False)

    _pending_upload_invalidation[key] = asyncio.create_task(trailing())


def pattern_priority_score(
    *, total_loss_cp: int, occurrences: int, positions: int
) -> float:
    """Balance expected cost with independent evidence that a pattern repeats.

    Raw cumulative loss lets a frequent, low-impact residual bucket dominate
    forever. Average loss alone overreacts to one spectacular blunder. Several
    visits to one exact position also are not independent evidence that a failure
    mode will transfer to a future game, so support grows with distinct positions.
    """

    if total_loss_cp <= 0 or occurrences <= 0 or positions <= 0:
        return 0.0
    return (total_loss_cp / occurrences) * sqrt(positions)


def pattern_priority_key(
    *, total_loss_cp: int, occurrences: int, positions: int
) -> tuple[bool, float, int]:
    """Return the complete ordering shared by live coaching and evaluation."""

    return (
        positions >= _HABIT_MIN_POSITIONS,
        pattern_priority_score(
            total_loss_cp=total_loss_cp,
            occurrences=occurrences,
            positions=positions,
        ),
        occurrences,
    )


_PATTERN_LABELS = {
    "time_pressure": "time pressure",
    "missed_mate": "missed forced mate",
    "allowed_mate": "allowed forced mate",
    "fork": "fork",
    "pin": "pin",
    "skewer": "skewer",
    "back_rank": "back rank",
    "removing_the_defender": "removing the defender",
    "advantage_conversion": "converting an advantage",
    "hanging_material": "hanging material",
    "king_safety": "king safety",
    "missed_capture": "missed capture",
    "missed_forcing_move": "missed forcing move",
    "opening_decision": "opening decision",
    "endgame_technique": "endgame technique",
    "defensive_resource": "defensive resource",
    "calculation": "calculation",
}

# The thinking routines a player can claim, each paired with the failure modes it
# actually catches. Feedback compares the claim with the detected pattern instead of
# guessing at what the player was thinking.
_INTENT_COVERAGE: dict[str, frozenset[str]] = {
    "opponent_captures": frozenset(
        {"hanging_material", "fork", "removing_the_defender", "skewer", "pin"}
    ),
    "threats_to_my_king": frozenset({"king_safety", "allowed_mate", "back_rank"}),
    "my_forcing_moves": frozenset(
        {"missed_capture", "missed_forcing_move", "missed_mate", "fork", "skewer", "pin"}
    ),
    "converting": frozenset({"advantage_conversion", "endgame_technique"}),
    "clock": frozenset({"time_pressure"}),
    "concrete_line": frozenset(
        {"calculation", "opening_decision", "defensive_resource", "endgame_technique"}
    ),
}

DRILL_INTENTS: tuple[DrillIntentOut, ...] = (
    DrillIntentOut(
        key="opponent_captures",
        label="Opponent's captures",
        prompt="I checked what the opponent could take.",
    ),
    DrillIntentOut(
        key="threats_to_my_king",
        label="Threats to my king",
        prompt="I checked the checks and threats against my king.",
    ),
    DrillIntentOut(
        key="my_forcing_moves",
        label="My forcing moves",
        prompt="I looked for my own checks, captures, and threats.",
    ),
    DrillIntentOut(
        key="converting",
        label="Converting",
        prompt="I was trying to convert a position I was already better in.",
    ),
    DrillIntentOut(
        key="clock",
        label="The clock",
        prompt="I moved fast because of the clock.",
    ),
    DrillIntentOut(
        key="concrete_line",
        label="A concrete line",
        prompt="I calculated one specific line.",
    ),
)


def compare_intent(intent_key: str | None, pattern_key: str) -> tuple[bool | None, str | None]:
    """Say whether the stated routine would have caught this failure mode."""

    if intent_key is None:
        return None, None
    coverage = _INTENT_COVERAGE.get(intent_key)
    if coverage is None:
        return None, None
    intent_label = next(
        (intent.label.lower() for intent in DRILL_INTENTS if intent.key == intent_key),
        intent_key,
    )
    pattern_label = _PATTERN_LABELS.get(pattern_key, pattern_key.replace("_", " "))
    if pattern_key in coverage:
        return True, (
            f"Checking {intent_label} is relevant to this {pattern_label} pattern. "
            "Now calculate the opponent's strongest reply and evaluate the position after it."
        )
    return False, (
        f"Checking {intent_label} does not directly cover this {pattern_label} pattern. "
        "Include that check in your candidate-move routine as well."
    )


@dataclass(frozen=True)
class MotifEvidence:
    """A named tactic plus the board fact that proves it, and whose line it is."""

    key: str
    label: str
    detail: str
    side: str  # "allowed" when the opponent played it, "missed" when the player could have


@dataclass(frozen=True)
class Pattern:
    key: str
    label: str
    phase: str
    explanation: str
    cue: str
    motifs: tuple[MotifEvidence, ...] = ()


# One key per motif keeps trend windows large enough to be measurable; the
# direction is carried by the explanation and the cue instead.
_MOTIF_LABELS = {
    "fork": "Fork",
    "pin": "Pin",
    "skewer": "Skewer",
    "back_rank": "Back rank",
    "removing_the_defender": "Removing the defender",
}

_MOTIF_CUES = {
    ("fork", "allowed"): (
        "Before moving, ask which two of your pieces a single knight, queen, or pawn "
        "could hit from one square."
    ),
    ("fork", "missed"): (
        "Scan for squares where one of your pieces would attack two enemy targets at once."
    ),
    ("pin", "allowed"): (
        "Check every open line to your king and queen before placing a piece on one."
    ),
    ("pin", "missed"): (
        "Look for enemy pieces standing on a line in front of something more valuable."
    ),
    ("skewer", "allowed"): (
        "Move your king or queen off open lines before the opponent lines it up with a piece behind it."
    ),
    ("skewer", "missed"): (
        "Look for checks that force a valuable piece to step aside and expose what stands behind it."
    ),
    ("back_rank", "allowed"): (
        "Give your king a flight square once heavy pieces are still on the board."
    ),
    ("back_rank", "missed"): (
        "When the enemy king has no escape square, check every rook and queen entry on its back rank."
    ),
    ("removing_the_defender", "allowed"): (
        "Before moving, note which of your pieces is the only defender of another."
    ),
    ("removing_the_defender", "missed"): (
        "When a target is defended once, look for a capture or attack on the defender first."
    ),
}


def _as_full_fen(fen: str) -> str:
    fields = fen.split()
    if len(fields) == 4:
        return f"{fen} 0 1"
    return fen


def _legal_move(board: chess.Board, uci: str | None) -> chess.Move | None:
    if not uci:
        return None
    try:
        move = chess.Move.from_uci(uci)
    except ValueError:
        return None
    return move if move in board.legal_moves else None


def _delivers_checkmate(board: chess.Board, uci: str | None) -> bool:
    """A legal terminal win is correct even when absent from the stored PV."""
    move = _legal_move(board, uci)
    if move is None:
        return False
    after = board.copy(stack=False)
    after.push(move)
    return after.is_checkmate()


def _phase(board: chess.Board, ply: int) -> str:
    if ply <= 20:
        return "opening"
    non_pawn_value = sum(
        len(board.pieces(piece_type, color)) * value
        for color in chess.COLORS
        for piece_type, value in (
            (chess.KNIGHT, 3),
            (chess.BISHOP, 3),
            (chess.ROOK, 5),
            (chess.QUEEN, 9),
        )
    )
    return "endgame" if non_pawn_value <= 13 else "middlegame"


def _starting_seconds(time_control: str | None) -> float | None:
    if not time_control or "/" in time_control:
        return None
    try:
        return float(time_control.split("+", 1)[0])
    except ValueError:
        return None


def _drill_seconds(card: DrillCardOut) -> int:
    return _TWO_MOVE_SECONDS if card.follow_up is not None else _SINGLE_MOVE_SECONDS


@lru_cache(maxsize=4096)
def structure_signature(fen: str) -> tuple[int, ...] | None:
    """Count the material that defines a position's shape, ignoring exact squares.

    Two positions with the same signature have the same pieces on the board and the
    same pawn balance, which is the most that can be claimed cheaply and honestly
    about structural similarity without a full pawn-skeleton comparison.
    """

    try:
        board = chess.Board(_as_full_fen(fen))
    except ValueError:
        return None
    counts = [
        len(board.pieces(piece_type, color))
        for color in (chess.WHITE, chess.BLACK)
        for piece_type in (chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT)
    ]
    counts.append(
        len(board.pieces(chess.PAWN, chess.WHITE)) - len(board.pieces(chess.PAWN, chess.BLACK))
    )
    return tuple(counts)


def _is_transfer_of(card: DrillCardOut, anchor: DrillCardOut, signatures: dict[int, Any]) -> bool:
    """A transfer drill is the same failure mode in a near-identical shape, elsewhere."""

    if card.position_id == anchor.position_id or card.source_game_id == anchor.source_game_id:
        return False
    if card.pattern_key != anchor.pattern_key or card.phase != anchor.phase:
        return False
    base, other = signatures.get(anchor.position_id), signatures.get(card.position_id)
    if base is None or other is None:
        return False
    return sum(abs(left - right) for left, right in zip(base, other, strict=True)) <= 1


def compose_session(
    ranked_cards: list[DrillCardOut],
    *,
    weak_pattern_keys: set[str],
    limit: int,
    budget_seconds: int = _SESSION_SECONDS,
) -> list[DrillCardOut]:
    """Fill one fixed-length set by rotating through the four reasons to train.

    Due reviews keep the spaced-repetition promise, recent errors keep the set tied to
    how the player is playing now, weak patterns push the failure modes that are getting
    worse, and transfer drills repeat the leading failure mode in a near-identical
    position from a different game. Whichever pool runs dry is replaced by the global
    ranking, so the set is always full when candidates exist. Every position comes from
    the player's own games: nothing unrelated is ever mixed in.
    """

    signatures = {card.position_id: structure_signature(card.fen) for card in ranked_cards}
    # Transfer runs straight after the first pick so the same idea is practised twice
    # in a row, in two different shapes, before the set moves on.
    sources = ("review", "transfer", "recent", "weak")

    def pool(source: str, anchor: DrillCardOut | None) -> list[DrillCardOut]:
        if source == "review":
            return [card for card in ranked_cards if card.attempts > 0]
        if source == "recent":
            return sorted(ranked_cards, key=lambda card: card.source_played_at, reverse=True)
        if source == "weak":
            return [card for card in ranked_cards if card.pattern_key in weak_pattern_keys]
        if anchor is None:
            return []
        return [card for card in ranked_cards if _is_transfer_of(card, anchor, signatures)]

    pools: dict[str, list[DrillCardOut]] = {
        source: pool(source, None) for source in ("review", "recent", "weak")
    }
    cursors = dict.fromkeys(sources, 0)
    used: set[int] = set()
    selected: list[DrillCardOut] = []
    spent = 0
    fallback = 0

    def take(candidates: list[DrillCardOut], start: int) -> tuple[DrillCardOut | None, int]:
        index = start
        while index < len(candidates):
            card = candidates[index]
            index += 1
            if card.position_id not in used:
                return card, index
        return None, index

    while len(selected) < limit:
        progressed = False
        for source in sources:
            if len(selected) >= limit:
                break
            if source == "transfer" and source not in pools:
                if not selected:
                    continue
                pools["transfer"] = pool("transfer", selected[0])
            chosen_source = source
            card, cursors[source] = take(pools[source], cursors[source])
            if card is None:
                chosen_source = "ranked"
                card, fallback = take(ranked_cards, fallback)
            if card is None:
                continue
            cost = _drill_seconds(card)
            if selected and spent + cost > budget_seconds:
                return selected
            used.add(card.position_id)
            card.queue_source = chosen_source
            selected.append(card)
            spent += cost
            progressed = True
        if not progressed:
            break
    return selected


def build_follow_up(fen: str, best_pv_uci: str | None) -> DrillFollowUpOut | None:
    """Replay two more plies of the stored best line so the drill can ask for a second move.

    Returns ``None`` when the line is too short, does not replay legally, or when the
    first move already ends the game: there is nothing left to calculate then.
    """

    moves = parse_pv(best_pv_uci)
    if len(moves) < 3:
        return None
    try:
        board = chess.Board(_as_full_fen(fen))
    except ValueError:
        return None

    best = _legal_move(board, moves[0])
    if best is None:
        return None
    board.push(best)
    if board.is_game_over():
        return None

    reply = _legal_move(board, moves[1])
    if reply is None:
        return None
    reply_san = board.san(reply)
    board.push(reply)
    if board.is_game_over():
        return None

    second = _legal_move(board, moves[2])
    if second is None:
        return None
    return DrillFollowUpOut(
        fen=board.fen(),
        opponent_reply_uci=reply.uci(),
        opponent_reply_san=reply_san,
        best_move_uci=second.uci(),
        best_move_san=board.san(second),
    )


def move_san(fen: str, move_uci: str, stored_san: str | None = None) -> str:
    """Return readable move notation even when an evaluator omitted SAN."""

    if stored_san:
        return stored_san
    try:
        board = chess.Board(_as_full_fen(fen))
        move = chess.Move.from_uci(move_uci)
        if move in board.legal_moves:
            return board.san(move)
    except ValueError:
        pass
    return move_uci


# Mate scores reach the learning queries as 1,800-2,000 (see the eval CASE).
_MATE_SCALE_CP = 1800


def _format_mover_eval(cp: int) -> str:
    """An evaluation from the mover's side, as a player reads one.

    "Lost 80.4 pawns" was how a king move from a won ending to a draw read. The
    before and after say more than their difference does — whether the position
    was won, level or lost, and what it became — and a mistake that left the
    mover still winning is shown as exactly that rather than hidden.
    """

    if cp >= _MATE_SCALE_CP:
        return "mate for you"
    if cp <= -_MATE_SCALE_CP:
        return "mate against you"
    return f"{cp / 100:+.1f}"


# Every uploaded evaluation invalidates the player's plan, and the crawler uploads
# about every forty seconds, so the plan was rebuilt cold on nearly every read —
# 5.7s measured, half of it re-classifying ~1,500 decisions that had not changed
# (detect_motifs alone computed ~25k SAN strings). The inputs are plain scalars
# and Pattern is frozen all the way down, so an unchanged decision can reuse its
# classification. A decision whose evaluation changed has a different key.
@lru_cache(maxsize=16_384)
def classify_pattern(
    *,
    fen: str,
    ply: int,
    user_move_uci: str,
    best_move_uci: str,
    opponent_reply_uci: str | None,
    parent_eval_cp: int,
    mover_is_white: bool,
    eval_drop_cp: int,
    user_move_san: str,
    best_move_san: str,
    clock_seconds_after: float | None = None,
    think_seconds: float | None = None,
    time_control: str | None = None,
    best_pv_uci: str | None = None,
    reply_pv_uci: str | None = None,
    best_eval_mate: int | None = None,
) -> Pattern:
    """Classify a mistake with deterministic board facts, never vague AI labels."""

    try:
        board = chess.Board(_as_full_fen(fen))
    except ValueError:
        phase = "opening" if ply <= 20 else "middlegame"
        return Pattern(
            key="calculation",
            label="Calculation",
            phase=phase,
            explanation=f"{user_move_san} lost {eval_drop_cp / 100:.1f} pawns; {best_move_san} was stronger.",
            cue="Compare forcing checks, captures, and threats before committing.",
        )

    phase = _phase(board, ply)
    user_move = _legal_move(board, user_move_uci)
    best_move = _legal_move(board, best_move_uci)
    perspective_eval = parent_eval_cp if mover_is_white else -parent_eval_cp

    after_user = board.copy(stack=False)
    if user_move is not None:
        after_user.push(user_move)
    reply = _legal_move(after_user, opponent_reply_uci)

    base = (
        f"{user_move_san} took the evaluation from {_format_mover_eval(perspective_eval)} "
        f"to {_format_mover_eval(perspective_eval - eval_drop_cp)}. "
        f"The stronger move was {best_move_san}."
    )

    mover_color = chess.WHITE if mover_is_white else chess.BLACK
    missed = detect_motifs(fen, best_pv_uci, mover=mover_color)
    allowed: list[Motif] = []
    if user_move is not None:
        allowed = detect_motifs(after_user.fen(), reply_pv_uci, mover=not mover_color)
    evidence = tuple(
        MotifEvidence(key=motif.key, label=motif.label, detail=motif.detail, side=side)
        for side, motifs in (("allowed", allowed), ("missed", missed))
        for motif in motifs
    )

    def _with_motifs(pattern: Pattern) -> Pattern:
        if not evidence:
            return pattern
        return Pattern(
            key=pattern.key,
            label=pattern.label,
            phase=pattern.phase,
            explanation=pattern.explanation,
            cue=pattern.cue,
            motifs=evidence,
        )

    allowed_keys = {motif.key: motif for motif in allowed}
    missed_keys = {motif.key: motif for motif in missed}

    if "mate" in missed_keys:
        mate_for_mover = best_eval_mate if mover_is_white else -(best_eval_mate or 0)
        return Pattern(
            key="missed_mate",
            label="Missed forced mate",
            phase=phase,
            explanation=(
                f"{base} That line "
                + (f"forces mate in {mate_for_mover}" if mate_for_mover and mate_for_mover > 0 else "ends in checkmate")
                + f": {missed_keys['mate'].detail}"
            ),
            cue=(
                "When the enemy king is short of squares, calculate every check to the end "
                "before grabbing material."
            ),
            motifs=evidence,
        )

    if "mate" in allowed_keys:
        return Pattern(
            key="allowed_mate",
            label="Allowed forced mate",
            phase=phase,
            explanation=f"{base} The stored reply line ends in checkmate: {allowed_keys['mate'].detail}",
            cue=(
                "Before moving, list the opponent's checks and confirm your king still has "
                "a flight square."
            ),
            motifs=evidence,
        )

    starting_seconds = _starting_seconds(time_control)
    if (
        clock_seconds_after is not None
        and starting_seconds is not None
        and clock_seconds_after <= max(15.0, starting_seconds * 0.1)
    ):
        detail = f" Only {clock_seconds_after:.0f} seconds remained after the move."
        if think_seconds is not None and think_seconds >= 1:
            detail += f" The move used {think_seconds:.0f} seconds."
        return _with_motifs(
            Pattern(
                key="time_pressure",
                label="Time pressure",
                phase=phase,
                explanation=base + detail,
                cue="Under 10% of your clock, still check the opponent's captures and checks before moving.",
            )
        )

    # A named tactic is more actionable than "you were winning and slipped", so the
    # motif branches run before the coarse phase-and-material fallbacks below.
    for motif_key in ("fork", "skewer", "pin", "back_rank", "removing_the_defender"):
        for side, table in (("allowed", allowed_keys), ("missed", missed_keys)):
            motif = table.get(motif_key)
            if motif is None:
                continue
            lead = (
                "Your move allowed it:"
                if side == "allowed"
                else f"{best_move_san} was the point:"
            )
            return Pattern(
                key=motif_key,
                label=_MOTIF_LABELS[motif_key],
                phase=phase,
                explanation=f"{base} {lead} {motif.detail}",
                cue=_MOTIF_CUES[(motif_key, side)],
                motifs=evidence,
            )

    if perspective_eval >= 150:
        return _with_motifs(Pattern(
            key="advantage_conversion",
            label="Converting an advantage",
            phase=phase,
            explanation=base,
            cue="When you are winning, find the opponent's threat before improving your own position.",
        ))

    if reply is not None and after_user.is_capture(reply):
        captured = after_user.piece_at(reply.to_square)
        if captured is not None and captured.piece_type in {
            chess.KNIGHT,
            chess.BISHOP,
            chess.ROOK,
            chess.QUEEN,
        }:
            return _with_motifs(Pattern(
                key="hanging_material",
                label="Hanging material",
                phase=phase,
                explanation=base,
                cue="After choosing a move, scan every opponent capture once more.",
            ))

    if reply is not None and after_user.gives_check(reply):
        return _with_motifs(Pattern(
            key="king_safety",
            label="King safety",
            phase=phase,
            explanation=base,
            cue="Before moving, check the opponent's forcing checks around your king.",
        ))

    if best_move is not None and board.is_capture(best_move):
        return _with_motifs(Pattern(
            key="missed_capture",
            label="Missed capture",
            phase=phase,
            explanation=base,
            cue="Start the candidate-move scan with captures, then checks, then threats.",
        ))

    if best_move is not None and board.gives_check(best_move):
        return _with_motifs(Pattern(
            key="missed_forcing_move",
            label="Missed forcing move",
            phase=phase,
            explanation=base,
            cue="Look for checks that improve your position, not only checks that look dramatic.",
        ))

    if phase == "opening":
        return _with_motifs(Pattern(
            key="opening_decision",
            label="Opening decision",
            phase=phase,
            explanation=base,
            cue="Develop the piece doing the least, unless the opponent's reply punishes it.",
        ))

    if phase == "endgame":
        return _with_motifs(Pattern(
            key="endgame_technique",
            label="Endgame technique",
            phase=phase,
            explanation=base,
            cue="Count every pawn race to the end before you trade pieces.",
        ))

    if perspective_eval <= -150:
        return _with_motifs(Pattern(
            key="defensive_resource",
            label="Defensive resource",
            phase=phase,
            explanation=base,
            cue="When worse, search for the move that creates the hardest concrete problem.",
        ))

    return _with_motifs(Pattern(
        key="calculation",
        label="Calculation",
        phase=phase,
        explanation=base,
        cue="Pick two candidate moves and calculate the opponent's strongest reply to each.",
    ))


def next_review(
    *,
    now: datetime,
    correct: bool,
    streak: int,
    interval_days: int,
    ease_factor: float,
) -> tuple[int, int, float, datetime]:
    """Return the next compact spaced-review state."""

    if not correct:
        return 0, 0, max(1.3, ease_factor - 0.2), now + timedelta(minutes=10)
    next_streak = streak + 1
    if next_streak == 1:
        next_interval = 1
    elif next_streak == 2:
        next_interval = 3
    else:
        next_interval = min(60, max(interval_days + 1, round(interval_days * ease_factor)))
    next_ease = min(2.8, ease_factor + 0.05)
    return next_streak, next_interval, next_ease, now + timedelta(days=next_interval)


_CANDIDATES_SQL = text("""
WITH
user_games AS (
    SELECT g.id, g.user_color, g.played_at, g.time_class, g.time_control, g.chesscom_game_url
    FROM games g
    WHERE g.username = :username
      AND (:color = 'both' OR g.user_color = :color)
      AND CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END >= :min_user_rating
      AND (:played_before IS NULL OR g.played_at < :played_before)
      AND (:played_from IS NULL OR g.played_at >= :played_from)
      AND (
          :time_class IS NULL
          OR (:time_class = 'rapid_blitz' AND g.time_class IN ('rapid', 'blitz'))
          OR g.time_class = :time_class
      )
),
-- Every trusted evaluation of a position, one row per searched depth. A
-- mistake is the *difference* between two positions, so the two sides have to
-- be searched to comparable depths; keeping each depth lets a decision pick a
-- depth both sides share instead of differencing a depth-30 parent against a
-- depth-22 child and charging the search artifact to the player.
position_evals AS (
    SELECT ar.position_id,
           CASE
               -- Capped at DECISIVE_CP (engine_contract.py): past it a score
               -- says only "decisive", and uncapped it ranks endgame
               -- tablebase scores as 80-pawn blunders.
               WHEN ar.eval_cp > 1500 THEN 1500
               WHEN ar.eval_cp < -1500 THEN -1500
               WHEN ar.eval_cp IS NOT NULL THEN ar.eval_cp
               WHEN ar.eval_mate > 0
                   THEN 2000 - (CASE WHEN ar.eval_mate > 20 THEN 20 ELSE ar.eval_mate END) * 10
               ELSE -2000 + (CASE WHEN ar.eval_mate < -20 THEN 20 ELSE -ar.eval_mate END) * 10
           END AS eval_cp,
           ar.eval_mate, ar.best_move_uci, ar.best_move_san, ar.pv_uci,
           NULL AS terminal_result, 0 AS terminal_priority, ar.depth AS eval_depth
    FROM analysis_results ar
    WHERE ar.multipv_rank = 1
      AND ar.engine = 'stockfish-19'
      AND ar.engine_version = '19'
      AND ar.depth >= :min_depth
      AND (ar.eval_cp IS NOT NULL OR ar.eval_mate IS NOT NULL)
    UNION ALL
    -- A finished game is exact rather than searched, so it has no depth to
    -- match and pairs with any evaluation.
    SELECT position_id, white_result * 2000, NULL, NULL, NULL, NULL,
           white_result, 1, NULL
    FROM position_outcomes
),
evaluated_gp AS MATERIALIZED (
    SELECT gp.game_id, gp.ply, gp.position_id, gp.move_uci, gp.move_san,
           gp.clock_seconds_after, gp.think_seconds,
           ug.user_color, ug.played_at, ug.time_class, ug.time_control, ug.chesscom_game_url,
           pe.eval_cp, pe.eval_mate, pe.best_move_uci, pe.best_move_san, pe.pv_uci,
           pe.terminal_result, pe.terminal_priority, pe.eval_depth
    FROM game_positions gp
    JOIN user_games ug ON ug.id = gp.game_id
    JOIN position_evals pe ON pe.position_id = gp.position_id
),
pair_candidates AS (
    SELECT
        parent.position_id AS position_id,
        child.move_uci AS user_move_uci,
        child.move_san AS user_move_san,
        parent.best_move_uci AS best_move_uci,
        parent.best_move_san AS best_move_san,
        child.best_move_uci AS opponent_reply_uci,
        -- The opponent's move that produced the position, so a drill can show
        -- what the player is answering instead of a bare board.
        parent.move_uci AS previous_move_uci,
        parent.pv_uci AS best_pv_uci,
        child.pv_uci AS reply_pv_uci,
        parent.eval_mate AS parent_eval_mate,
        parent.eval_cp AS parent_eval_cp,
        child.ply AS ply,
        child.game_id AS source_game_id,
        child.played_at AS source_played_at,
        child.time_class AS time_class,
        child.time_control AS time_control,
        child.clock_seconds_after AS clock_seconds_after,
        child.think_seconds AS think_seconds,
        child.chesscom_game_url AS source_game_url,
        parent.terminal_priority + child.terminal_priority AS terminal_priority,
        CASE
            WHEN parent.eval_depth IS NULL OR child.eval_depth IS NULL THEN 0
            ELSE ABS(parent.eval_depth - child.eval_depth)
        END AS depth_gap,
        COALESCE(parent.eval_depth, 0) + COALESCE(child.eval_depth, 0) AS depth_total,
        CASE
            -- Once every move loses by force, shorter mate or a different
            -- numeric score cannot represent a new loss of winning chances.
            WHEN (parent.eval_mate < 0 AND child.user_color = 'white')
              OR (parent.eval_mate > 0 AND child.user_color = 'black') THEN 0
            WHEN (child.eval_mate > 0 AND child.user_color = 'white')
              OR (child.eval_mate < 0 AND child.user_color = 'black') THEN 0
            WHEN (child.terminal_result = 1 AND child.user_color = 'white')
              OR (child.terminal_result = -1 AND child.user_color = 'black') THEN 0
            WHEN child.user_color = 'white' THEN parent.eval_cp - child.eval_cp
            ELSE child.eval_cp - parent.eval_cp
        END AS cp_loss
    FROM evaluated_gp child
    JOIN evaluated_gp parent
      ON parent.game_id = child.game_id
     AND parent.ply = child.ply - 1
    -- Only what the decision *is* belongs here. What it is worth — whether the
    -- played move was the engine's choice, whether the loss clears the
    -- threshold — is judged after the measurement has been chosen, so a
    -- shallower pair cannot win the decision by looking more like a mistake.
    WHERE child.move_uci IS NOT NULL
      AND parent.position_id NOT IN :excluded_positions
      -- Stockfish reports the depth it finished on, so a requested depth can
      -- land a ply or two higher. Tolerate that much and no more.
      AND (
          parent.eval_depth IS NULL
          OR child.eval_depth IS NULL
          OR ABS(parent.eval_depth - child.eval_depth) <= :max_pair_depth_gap
      )
      AND (
          (child.user_color = 'white' AND child.ply % 2 = 1)
          OR (child.user_color = 'black' AND child.ply % 2 = 0)
      )
),
-- One measurement per decision: the closest-matched, deepest pair of searches
-- available for it.
ranked_pairs AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY source_game_id, ply
        ORDER BY terminal_priority DESC, depth_gap ASC, depth_total DESC
    ) AS eval_rank
    FROM pair_candidates
),
measured_decisions AS (
    SELECT * FROM ranked_pairs
    WHERE eval_rank = 1
      AND best_move_uci IS NOT NULL
      AND best_move_uci <> user_move_uci
      AND (
          :review_due_at IS NULL OR EXISTS (
              SELECT 1 FROM drill_progress dp
              WHERE dp.username = :username
                AND dp.position_id = ranked_pairs.position_id
                AND dp.expected_move_uci = ranked_pairs.best_move_uci
                AND dp.attempts > 0
                AND dp.due_at <= :review_due_at
          )
      )
),
mistake_rows AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY position_id, user_move_uci
        ORDER BY source_played_at DESC, source_game_id DESC
    ) AS recent_rank
    FROM measured_decisions
),
grouped_candidates AS (
SELECT
    position_id,
    user_move_uci,
    MAX(user_move_san) AS user_move_san,
    MAX(best_move_uci) AS best_move_uci,
    MAX(best_move_san) AS best_move_san,
    MAX(opponent_reply_uci) AS opponent_reply_uci,
    MAX(best_pv_uci) AS best_pv_uci,
    MAX(reply_pv_uci) AS reply_pv_uci,
    MAX(parent_eval_mate) AS parent_eval_mate,
    MAX(parent_eval_cp) AS parent_eval_cp,
    MIN(ply) AS ply,
    MAX(cp_loss) AS eval_drop_cp,
    COUNT(*) AS occurrences,
    MAX(CASE WHEN recent_rank = 1 THEN source_game_id END) AS source_game_id,
    MAX(CASE WHEN recent_rank = 1 THEN source_played_at END) AS source_played_at,
    MAX(CASE WHEN recent_rank = 1 THEN time_class END) AS time_class,
    MAX(CASE WHEN recent_rank = 1 THEN time_control END) AS time_control,
    MAX(CASE WHEN recent_rank = 1 THEN clock_seconds_after END) AS clock_seconds_after,
    MAX(CASE WHEN recent_rank = 1 THEN think_seconds END) AS think_seconds,
    MAX(CASE WHEN recent_rank = 1 THEN source_game_url END) AS source_game_url,
    MAX(CASE WHEN recent_rank = 1 THEN previous_move_uci END) AS previous_move_uci
FROM mistake_rows
WHERE cp_loss >= :threshold_cp
GROUP BY position_id, user_move_uci
),
unique_candidates AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY position_id
        ORDER BY eval_drop_cp DESC, occurrences DESC, user_move_uci
    ) AS position_rank
    FROM grouped_candidates
)
SELECT * FROM unique_candidates WHERE position_rank = 1
ORDER BY eval_drop_cp DESC, occurrences DESC, position_id
LIMIT :scan_limit
OFFSET :scan_offset
""").bindparams(
    bindparam("time_class", type_=Text()),
    bindparam("played_before", type_=DateTime(timezone=True)),
    bindparam("played_from", type_=DateTime(timezone=True)),
    bindparam("review_due_at", type_=DateTime(timezone=True)),
    bindparam("excluded_positions", expanding=True, type_=Integer()),
    bindparam("max_pair_depth_gap", type_=Integer()),
    bindparam("scan_offset", type_=Integer()),
)


_TREND_ROWS_SQL = text("""
WITH
latest_games AS MATERIALIZED (
    SELECT g.id, g.user_color, g.time_control, g.played_at
    FROM games g
    WHERE g.username = :username
      AND (:color = 'both' OR g.user_color = :color)
      AND CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END >= :min_user_rating
      AND (
          :time_class IS NULL
          OR (:time_class = 'rapid_blitz' AND g.time_class IN ('rapid', 'blitz'))
          OR g.time_class = :time_class
      )
    ORDER BY g.played_at DESC, g.id DESC
    LIMIT 60
),
ranked_games AS (
    SELECT *, ROW_NUMBER() OVER (ORDER BY played_at DESC, id DESC) AS game_rank
    FROM latest_games
),
recent_gp AS MATERIALIZED (
    SELECT gp.game_id, gp.ply, gp.position_id, gp.move_uci, gp.move_san,
           gp.clock_seconds_after, gp.think_seconds,
           rg.user_color, rg.time_control, rg.game_rank
    FROM ranked_games rg
    JOIN game_positions gp ON gp.game_id = rg.id
),
position_evals AS (
    SELECT ar.position_id,
           CASE
               -- Capped at DECISIVE_CP (engine_contract.py): past it a score
               -- says only "decisive", and uncapped it ranks endgame
               -- tablebase scores as 80-pawn blunders.
               WHEN ar.eval_cp > 1500 THEN 1500
               WHEN ar.eval_cp < -1500 THEN -1500
               WHEN ar.eval_cp IS NOT NULL THEN ar.eval_cp
               WHEN ar.eval_mate > 0
                   THEN 2000 - (CASE WHEN ar.eval_mate > 20 THEN 20 ELSE ar.eval_mate END) * 10
               ELSE -2000 + (CASE WHEN ar.eval_mate < -20 THEN 20 ELSE -ar.eval_mate END) * 10
           END AS eval_cp,
           ar.eval_mate, ar.best_move_uci, ar.best_move_san, ar.pv_uci,
           NULL AS terminal_result, ar.depth AS eval_depth
    FROM analysis_results ar
    WHERE ar.multipv_rank = 1
      AND ar.engine = 'stockfish-19'
      AND ar.engine_version = '19'
      AND ar.depth >= :min_depth
      AND (ar.eval_cp IS NOT NULL OR ar.eval_mate IS NOT NULL)
    UNION ALL
    SELECT position_id, white_result * 2000, NULL, NULL, NULL, NULL,
           white_result, NULL
    FROM position_outcomes
),
evaluated_gp AS MATERIALIZED (
    SELECT gp.game_id, gp.ply, gp.position_id, gp.move_uci, gp.move_san,
           gp.clock_seconds_after, gp.think_seconds,
           gp.user_color, gp.time_control, gp.game_rank,
           p.fen, pe.eval_cp, pe.eval_mate, pe.best_move_uci, pe.best_move_san, pe.pv_uci,
           pe.terminal_result, pe.eval_depth
    FROM recent_gp gp
    LEFT JOIN position_evals pe ON pe.position_id = gp.position_id
    JOIN positions p ON p.id = gp.position_id
),
-- Each decision keeps every pair of searches that could measure it, then one
-- is chosen: a measured pair over an unmeasured one, the closest-matched
-- depths over a wider gap, and the deepest of those. A pair searched to depths
-- further apart than the engine's own reporting slack measures nothing — the
-- gap alone can exceed the blunder threshold — so it reports as unanalyzed
-- rather than as a loss the player never gave away.
pair_candidates AS (
    SELECT
        parent.fen,
        parent.position_id,
        parent.eval_cp AS parent_eval_cp,
        parent.best_move_uci,
        parent.best_move_san,
        parent.pv_uci AS best_pv_uci,
        parent.eval_mate AS parent_eval_mate,
        child.game_id AS source_game_id,
        child.move_uci AS user_move_uci,
        child.move_san AS user_move_san,
        child.best_move_uci AS opponent_reply_uci,
        child.pv_uci AS reply_pv_uci,
        child.clock_seconds_after,
        child.think_seconds,
        child.time_control,
        child.user_color,
        child.game_rank,
        child.ply,
        CASE
            WHEN parent.eval_depth IS NULL OR child.eval_depth IS NULL THEN 0
            ELSE ABS(parent.eval_depth - child.eval_depth)
        END AS depth_gap,
        COALESCE(parent.eval_depth, 0) + COALESCE(child.eval_depth, 0) AS depth_total,
        CASE WHEN parent.eval_cp IS NOT NULL AND child.eval_cp IS NOT NULL
                  AND parent.best_move_uci IS NOT NULL
                  AND (
                      parent.eval_depth IS NULL
                      OR child.eval_depth IS NULL
                      OR ABS(parent.eval_depth - child.eval_depth) <= :max_pair_depth_gap
                  )
             THEN 1 ELSE 0 END AS analyzed,
        CASE
            WHEN parent.eval_depth IS NOT NULL AND child.eval_depth IS NOT NULL
                 AND ABS(parent.eval_depth - child.eval_depth) > :max_pair_depth_gap THEN 0
            WHEN parent.best_move_uci = child.move_uci THEN 0
            WHEN (parent.eval_mate < 0 AND child.user_color = 'white')
              OR (parent.eval_mate > 0 AND child.user_color = 'black') THEN 0
            WHEN (child.eval_mate > 0 AND child.user_color = 'white')
              OR (child.eval_mate < 0 AND child.user_color = 'black') THEN 0
            WHEN (child.terminal_result = 1 AND child.user_color = 'white')
              OR (child.terminal_result = -1 AND child.user_color = 'black') THEN 0
            WHEN child.user_color = 'white' THEN parent.eval_cp - child.eval_cp
            ELSE child.eval_cp - parent.eval_cp
        END AS cp_loss
    FROM evaluated_gp child
    JOIN evaluated_gp parent
      ON parent.game_id = child.game_id
     AND parent.ply = child.ply - 1
    WHERE child.move_uci IS NOT NULL
      AND (
          (child.user_color = 'white' AND child.ply % 2 = 1)
          OR (child.user_color = 'black' AND child.ply % 2 = 0)
      )
),
ranked_pairs AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY source_game_id, ply
        ORDER BY analyzed DESC, depth_gap ASC, depth_total DESC
    ) AS eval_rank
    FROM pair_candidates
)
SELECT
    fen,
    position_id,
    parent_eval_cp,
    best_move_uci,
    best_move_san,
    best_pv_uci,
    parent_eval_mate,
    user_move_uci,
    user_move_san,
    opponent_reply_uci,
    reply_pv_uci,
    clock_seconds_after,
    think_seconds,
    time_control,
    user_color,
    game_rank,
    ply,
    analyzed,
    cp_loss
FROM ranked_pairs
WHERE eval_rank = 1
ORDER BY game_rank, ply
""").bindparams(
    bindparam("time_class", type_=Text()),
    bindparam("max_pair_depth_gap", type_=Integer()),
)


async def _sparring_candidates(
    session: AsyncSession, *, username: str, threshold_cp: int, limit: int = 200
) -> list[dict[str, Any]]:
    """Recent mistakes from games against the engine, shaped like SQL candidates."""

    rows = (await session.execute(
        select(SparringMistake, SparringGame, Position.fen)
        .join(SparringGame, SparringGame.id == SparringMistake.game_id)
        .join(Position, Position.id == SparringMistake.position_id)
        .where(SparringGame.username == username, SparringMistake.eval_drop_cp >= threshold_cp)
        .order_by(SparringGame.played_at.desc(), SparringMistake.ply.asc())
        .limit(limit)
    )).all()
    # Drill answers are graded against the deepest trusted evaluation of the
    # position (`record_drill_attempt`), so the card must quote that same one:
    # the review's own results are uploaded with it, and a deeper search that
    # arrives later wins. A position without one yet waits for it.
    position_ids = {mistake.position_id for mistake, _, _ in rows}
    deepest: dict[int, tuple[str, str | None]] = {}
    if position_ids:
        for position_id, best, pv in (await session.execute(
            select(AnalysisResult.position_id, AnalysisResult.best_move_uci, AnalysisResult.pv_uci)
            .where(
                AnalysisResult.position_id.in_(position_ids),
                AnalysisResult.engine == ENGINE_NAME,
                AnalysisResult.engine_version == ENGINE_VERSION,
                AnalysisResult.multipv_rank == 1,
                AnalysisResult.depth >= MIN_TRUSTED_DEPTH,
            )
            .order_by(AnalysisResult.position_id, AnalysisResult.depth.desc(), AnalysisResult.id.desc())
        )).all():
            deepest.setdefault(int(position_id), (best, pv))
    items: list[dict[str, Any]] = []
    for mistake, game, fen in rows:
        trusted = deepest.get(mistake.position_id)
        if trusted is None or not trusted[0] or trusted[0] == mistake.user_move_uci:
            continue
        best_move_uci, best_pv_uci = trusted
        reply = (mistake.reply_pv_uci or "").split()
        item: dict[str, Any] = {
            "position_id": mistake.position_id,
            "fen": fen,
            "ply": mistake.ply,
            "user_move_uci": mistake.user_move_uci,
            "user_move_san": mistake.user_move_san,
            "best_move_uci": best_move_uci,
            "best_move_san": move_san(fen, best_move_uci),
            "opponent_reply_uci": reply[0] if reply else None,
            "previous_move_uci": mistake.previous_move_uci,
            "best_pv_uci": best_pv_uci,
            "reply_pv_uci": mistake.reply_pv_uci,
            "parent_eval_cp": mistake.parent_eval_cp,
            "parent_eval_mate": mistake.parent_eval_mate,
            "eval_drop_cp": mistake.eval_drop_cp,
            "occurrences": 1,
            "source_game_id": game.id,
            "source_game_url": "",
            "source_played_at": game.played_at.isoformat(),
            "time_class": "engine",
            "time_control": None,
            "clock_seconds_after": None,
            "think_seconds": None,
        }
        item["analysis"] = _analyse_candidate(item)
        items.append(item)
    return items


def _analyse_candidate(item: dict[str, Any]) -> dict[str, Any] | None:
    """Pre-compute the board-replay work so a warm plan read stays cheap."""

    fen = item.get("fen")
    if not fen:
        return None
    pattern = classify_pattern(
        fen=fen,
        ply=item["ply"],
        user_move_uci=item["user_move_uci"],
        best_move_uci=item["best_move_uci"],
        opponent_reply_uci=item.get("opponent_reply_uci"),
        parent_eval_cp=item["parent_eval_cp"],
        mover_is_white=fen.split()[1] == "w",
        eval_drop_cp=item["eval_drop_cp"],
        user_move_san=item["user_move_san"],
        best_move_san=item["best_move_san"] or item["best_move_uci"],
        clock_seconds_after=item.get("clock_seconds_after"),
        think_seconds=item.get("think_seconds"),
        time_control=item.get("time_control"),
        best_pv_uci=item.get("best_pv_uci"),
        reply_pv_uci=item.get("reply_pv_uci"),
        best_eval_mate=item.get("parent_eval_mate"),
    )
    follow_up = build_follow_up(fen, item.get("best_pv_uci"))
    return {
        "key": pattern.key,
        "label": pattern.label,
        "phase": pattern.phase,
        "explanation": pattern.explanation,
        "cue": pattern.cue,
        "motifs": [
            {"key": m.key, "label": m.label, "detail": m.detail, "side": m.side}
            for m in pattern.motifs
        ],
        "follow_up": follow_up.model_dump(mode="json") if follow_up else None,
    }


async def _review_cache_token(session, username, due_at, excluded_positions):
    rows = (await session.execute(
        select(DrillProgress.position_id, DrillProgress.expected_move_uci,
               DrillProgress.attempts, DrillProgress.due_at)
        .where(DrillProgress.username == username, DrillProgress.attempts > 0,
               DrillProgress.due_at <= due_at,
               DrillProgress.position_id.not_in(excluded_positions or []))
        .order_by(DrillProgress.position_id, DrillProgress.expected_move_uci)
        .limit(10_001)
    )).all()
    # Bound key construction; unusually large review histories remain uncached.
    if not rows:
        return ""  # No due reviews outside the existing candidate positions.
    if len(rows) > 10_000:
        return None
    payload = [[pid, move, attempts, due.isoformat()] for pid, move, attempts, due in rows]
    return hashlib.sha256(json.dumps([payload, sorted(set(excluded_positions or []))]).encode()).hexdigest()


async def _load_candidates(
    session: AsyncSession,
    *,
    username: str,
    color: str,
    time_class: str,
    threshold_cp: int,
    min_depth: int,
    min_user_rating: int = DEFAULT_MIN_USER_RATING,
    played_before: datetime | None = None,
    played_from: datetime | None = None,
    review_due_at: datetime | None = None,
    excluded_positions: list[int] | None = None,
    scan_offset: int = 0,
    cache_results: bool = True,
) -> list[dict[str, Any]]:
    cache = get_shared_cache()
    window = (
        f":{played_before.isoformat() if played_before else ''}"
        f":{played_from.isoformat() if played_from else ''}"
    )
    cache_key = (
        f"improvement:candidates:v{_CANDIDATE_CACHE_VERSION}:{username}:{color}:{time_class}:"
        f"{threshold_cp}:{min_depth}:{min_user_rating}{window}"
    )
    if scan_offset:
        cache_key += f":offset:{scan_offset}"
    # Due reviews depend on live progress, not the cached historical ranking.
    use_cache = review_due_at is None and not excluded_positions
    review_token = None
    if review_due_at is not None:
        review_token = await _review_cache_token(session, username, review_due_at, excluded_positions)
        if review_token == "":
            return []
        if review_token is not None:
            cache_key += f":reviews:{review_token}"
            use_cache = True
    cache_key = await cache.versioned_key(cache_key)
    use_cache = use_cache and cache_results
    cached = await cache.get_json(cache_key) if use_cache else None
    if cached is not None:
        return list(cached)

    is_postgresql = (
        session.bind is not None and session.bind.dialect.name == "postgresql"
    )
    if is_postgresql:
        await session.execute(text("SET LOCAL enable_nestloop = off"))
    rows = (
        await session.execute(
            _CANDIDATES_SQL,
            {
                "username": username,
                "color": color,
                "time_class": time_class,
                "threshold_cp": threshold_cp,
                "min_depth": min_depth,
                "min_user_rating": min_user_rating,
                "played_before": played_before,
                "played_from": played_from,
                "max_pair_depth_gap": MAX_PAIR_DEPTH_GAP,
                "scan_limit": _CANDIDATE_SCAN_LIMIT,
                "scan_offset": scan_offset,
                "review_due_at": review_due_at,
                "excluded_positions": excluded_positions or [],
            },
        )
    ).mappings().all()
    if is_postgresql:
        await session.execute(text("SET LOCAL enable_nestloop = on"))
    if review_token is not None:
        # Do not publish a result under an earlier progress state if an answer
        # was recorded while SQL ran. Attempt counters prevent state-key reuse.
        use_cache = cache_results and review_token == await _review_cache_token(
            session, username, review_due_at, excluded_positions,
        )
    if not rows:
        if use_cache:
            await cache.set_json(cache_key, [], ttl_seconds=_CANDIDATE_CACHE_SECONDS)
        return []

    position_ids = [int(row["position_id"]) for row in rows]
    fen_rows = await session.execute(
        select(Position.id, Position.fen).where(Position.id.in_(position_ids))
    )
    fens = {int(position_id): fen for position_id, fen in fen_rows.all()}

    serializable: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["position_id"] = int(item["position_id"])
        item["fen"] = fens.get(item["position_id"], "")
        item["best_move_san"] = move_san(
            item["fen"], item["best_move_uci"], item.get("best_move_san")
        )
        played_at = item["source_played_at"]
        item["source_played_at"] = (
            played_at.isoformat() if isinstance(played_at, datetime) else str(played_at)
        )
        for key in ("parent_eval_cp", "ply", "eval_drop_cp", "occurrences", "source_game_id"):
            item[key] = int(item[key])
        for key in ("clock_seconds_after", "think_seconds"):
            item[key] = float(item[key]) if item[key] is not None else None
        item["parent_eval_mate"] = (
            int(item["parent_eval_mate"]) if item["parent_eval_mate"] is not None else None
        )
        for key in ("best_pv_uci", "reply_pv_uci"):
            item[key] = str(item[key]) if item[key] is not None else None
        item["analysis"] = _analyse_candidate(item)
        serializable.append(item)
    if use_cache:
        await cache.set_json(cache_key, serializable, ttl_seconds=_CANDIDATE_CACHE_SECONDS)
    return serializable


_COVERAGE_SQL = text("""
WITH
user_games AS (
    SELECT g.id, g.user_color
    FROM games g
    WHERE g.username = :username
      AND (:color = 'both' OR g.user_color = :color)
      AND CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END >= :min_user_rating
      AND (
          :time_class IS NULL
          OR (:time_class = 'rapid_blitz' AND g.time_class IN ('rapid', 'blitz'))
          OR g.time_class = :time_class
      )
),
decisions AS MATERIALIZED (
    SELECT gp.game_id, gp.ply, gp.position_id
    FROM game_positions gp
    JOIN user_games ug ON ug.id = gp.game_id
    WHERE gp.move_uci IS NOT NULL
      AND (
          (ug.user_color = 'white' AND gp.ply % 2 = 1)
          OR (ug.user_color = 'black' AND gp.ply % 2 = 0)
      )
),
evaluated AS (
    SELECT ar.position_id, ar.depth
    FROM analysis_results ar
    WHERE ar.multipv_rank = 1
      AND ar.engine = 'stockfish-19'
      AND ar.engine_version = '19'
      AND ar.depth >= :min_depth
      AND (ar.eval_cp IS NOT NULL OR ar.eval_mate IS NOT NULL)
    UNION ALL
    SELECT position_id, NULL FROM position_outcomes
),
-- A decision counts as analyzed when it can actually be graded: both of its
-- positions searched to a depth they share. One side left deeper than the other
-- measures the gap between two searches, not the move.
analyzed_boards AS MATERIALIZED (
    SELECT DISTINCT d.game_id, d.ply, lower(__BOARD_PLACEMENT__) AS pieces
    FROM decisions d
    JOIN game_positions parent
      ON parent.game_id = d.game_id AND parent.ply = d.ply - 1
    JOIN evaluated moved ON moved.position_id = d.position_id
    JOIN evaluated before
      ON before.position_id = parent.position_id
     AND (
         moved.depth IS NULL
         OR before.depth IS NULL
         OR ABS(moved.depth - before.depth) <= :max_pair_depth_gap
     )
    JOIN positions p ON p.id = parent.position_id
),
analyzed_decisions AS (
    SELECT CASE
        WHEN ply <= 20 THEN 'opening'
        WHEN 3 * (length(pieces) - length(replace(pieces, 'n', '')))
           + 3 * (length(pieces) - length(replace(pieces, 'b', '')))
           + 5 * (length(pieces) - length(replace(pieces, 'r', '')))
           + 9 * (length(pieces) - length(replace(pieces, 'q', ''))) <= 13
            THEN 'endgame'
        ELSE 'middlegame'
    END AS phase FROM analyzed_boards
)
SELECT
    (SELECT COUNT(*) FROM decisions) AS total_decisions,
    (SELECT COUNT(*) FROM analyzed_decisions) AS analyzed_decisions,
    (SELECT COUNT(*) FROM analyzed_decisions WHERE phase = 'opening') AS analyzed_opening,
    (SELECT COUNT(*) FROM analyzed_decisions WHERE phase = 'middlegame') AS analyzed_middlegame,
    (SELECT COUNT(*) FROM analyzed_decisions WHERE phase = 'endgame') AS analyzed_endgame
""").bindparams(bindparam("time_class", type_=Text()))


async def _coverage(
    session: AsyncSession,
    *,
    username: str,
    color: str,
    time_class: str,
    min_depth: int,
    min_user_rating: int,
) -> tuple[int, int, list[PhaseCoverageOut]]:
    """Count the player's own decisions, and how many can actually be judged.

    Dividing evaluated positions by every position in every game answers a question
    nobody asked: most of those are the opponent's moves, or positions the player
    never had to choose in. A decision only counts as analyzed when the position
    before the move and the position after it both carry a trusted evaluation,
    because that pair is exactly what a drill needs.
    """

    cache = get_shared_cache()
    cache_key = f"improvement:coverage:v7:{username}:{color}:{time_class}:{min_depth}:{min_user_rating}"
    cache_key = await cache.versioned_key(cache_key)
    cached = await cache.get_json(cache_key)
    if cached is not None:
        return (
            int(cached["total"]),
            int(cached["analyzed"]),
            [PhaseCoverageOut.model_validate(item) for item in cached["phases"]],
        )

    placement = "split_part(p.fen, ' ', 1)" if session.bind is not None and session.bind.dialect.name == "postgresql" else "substr(p.fen, 1, instr(p.fen, ' ') - 1)"
    coverage_sql = text(
        _COVERAGE_SQL.text.replace("__BOARD_PLACEMENT__", placement)
    ).bindparams(
        bindparam("time_class", type_=Text()),
        bindparam("max_pair_depth_gap", type_=Integer()),
    )
    row = (
        await session.execute(
            coverage_sql,
            {"username": username, "color": color, "time_class": time_class,
             "min_depth": min_depth, "min_user_rating": min_user_rating,
             "max_pair_depth_gap": MAX_PAIR_DEPTH_GAP},
        )
    ).mappings().one()

    total = int(row["total_decisions"] or 0)
    analyzed = int(row["analyzed_decisions"] or 0)
    phases = [
        PhaseCoverageOut(
            phase=phase,
            analyzed_decisions=int(row[column] or 0),
            share=round(int(row[column] or 0) / analyzed, 4) if analyzed else 0.0,
        )
        for phase, column in (
            ("opening", "analyzed_opening"),
            ("middlegame", "analyzed_middlegame"),
            ("endgame", "analyzed_endgame"),
        )
    ]
    await cache.set_json(
        cache_key,
        {
            "total": total,
            "analyzed": analyzed,
            "phases": [item.model_dump(mode="json") for item in phases],
        },
        # Evidence changes bump the generation, so this only bounds staleness.
        ttl_seconds=300.0,
    )
    return total, analyzed, phases


async def _outcome_context(
    session: AsyncSession,
    *,
    username: str,
    color: str,
    time_class: str,
    min_user_rating: int,
) -> tuple[list[OutcomeInsightOut], list[OpeningPriorityOut]]:
    cache = get_shared_cache()
    cache_key = f"improvement:context:{username}:{color}:{time_class}:{min_user_rating}"
    cache_key = await cache.versioned_key(cache_key)
    cached = await cache.get_json(cache_key)
    if cached is not None:
        return (
            [OutcomeInsightOut.model_validate(item) for item in cached["insights"]],
            [OpeningPriorityOut.model_validate(item) for item in cached["openings"]],
        )

    filters = [
        Game.username == username,
        user_rating_condition(Game, min_user_rating),
    ]
    if color != "both":
        filters.append(Game.user_color == color)
    time_filter = time_class_condition(Game.time_class, time_class)
    if time_filter is not None:
        filters.append(time_filter)

    outcome_rows = await session.execute(
        select(
            Game.time_class,
            func.sum(case((Game.user_result == "loss", 1), else_=0)),
            func.sum(
                case(
                    (
                        (Game.user_result == "loss") & (Game.termination == "timeout"),
                        1,
                    ),
                    else_=0,
                )
            ),
        )
        .where(*filters)
        .group_by(Game.time_class)
    )
    insights: list[OutcomeInsightOut] = []
    for class_name, losses, timeout_losses in outcome_rows.all():
        losses = int(losses or 0)
        timeout_losses = int(timeout_losses or 0)
        if losses < 10 or timeout_losses < 3:
            continue
        rate = timeout_losses / losses
        if rate < 0.08:
            continue
        insights.append(
            OutcomeInsightOut(
                key=f"{class_name}_clock_management",
                label=f"{class_name.title()} clock management",
                detail=(
                    f"{timeout_losses} of {losses} {class_name} losses ended on time "
                    f"({rate:.0%})."
                ),
                occurrences=timeout_losses,
                sample_games=losses,
                rate=round(rate, 4),
                cue="At half your starting time, simplify the position and shorten the candidate-move scan.",
            )
        )
    insights.sort(key=lambda item: (item.rate, item.occurrences), reverse=True)

    opening_rows = await session.execute(
        select(
            Game.time_class,
            func.coalesce(Game.opening_name, "Unknown"),
            func.count(Game.id),
            func.sum(case((Game.user_result == "win", 1), else_=0)),
            func.sum(case((Game.user_result == "draw", 1), else_=0)),
        )
        .where(*filters)
        .group_by(Game.time_class, Game.opening_name)
        .having(func.count(Game.id) >= 20)
    )
    opening_priorities = [
        OpeningPriorityOut(
            opening_name=opening_name,
            time_class=class_name,
            games=int(games),
            score_rate=round((int(wins or 0) + 0.5 * int(draws or 0)) / int(games), 4),
        )
        for class_name, opening_name, games, wins, draws in opening_rows.all()
    ]
    opening_priorities.sort(key=lambda item: (item.score_rate, -item.games))
    opening_priorities = opening_priorities[:5]
    await cache.set_json(
        cache_key,
        {
            "insights": [item.model_dump(mode="json") for item in insights],
            "openings": [item.model_dump(mode="json") for item in opening_priorities],
        },
        ttl_seconds=300.0,
    )
    return insights, opening_priorities


def trend_status(
    *,
    recent_occurrences: int,
    previous_occurrences: int,
    recent_rate: float,
    previous_rate: float,
    recent_games: int,
    previous_games: int,
    minimum_decisions: int,
    recent_missing_decisions: int,
    previous_missing_decisions: int,
) -> tuple[str, str]:
    """Decide a trend direction and how much to trust it, or refuse to call one."""

    pattern_samples = recent_occurrences + previous_occurrences
    if not (
        recent_games == 30
        and previous_games == 30
        and minimum_decisions >= 30
        and pattern_samples >= _TREND_MIN_PATTERN_SAMPLES
    ):
        return "insufficient", "low"

    # Observed per-game rates are lower bounds while some decisions have no
    # trusted evaluation. Each missing decision could contribute one error of
    # this pattern. Require the direction to survive that worst case, rather
    # than treating unmeasured play as error-free play.
    recent_upper = recent_rate + recent_missing_decisions * 100 / recent_games
    previous_upper = previous_rate + previous_missing_decisions * 100 / previous_games
    delta = recent_rate - previous_rate
    meaningful_change = max(1.0, previous_rate * 0.2)
    # A direction is only called when the window that carries the claim is itself
    # large enough: 2 occurrences dropping to 0 is not an improvement.
    if delta <= -meaningful_change:
        status = (
            "improving"
            if previous_occurrences >= _TREND_MIN_WINDOW_OCCURRENCES
            and recent_upper - previous_rate <= -meaningful_change
            else "insufficient"
        )
    elif delta >= meaningful_change:
        status = (
            "worsening"
            if recent_occurrences >= _TREND_MIN_WINDOW_OCCURRENCES
            and recent_rate - previous_upper >= max(1.0, previous_upper * 0.2)
            else "insufficient"
        )
    else:
        status = "insufficient" if recent_missing_decisions or previous_missing_decisions else "steady"

    if status == "insufficient":
        return status, "low"
    if recent_missing_decisions or previous_missing_decisions:
        return status, "low"
    if minimum_decisions >= 200 and pattern_samples >= 20:
        return status, "high"
    if pattern_samples >= 10:
        return status, "medium"
    return status, "low"


def _retention(progress: list[DrillProgress]) -> RetentionOut:
    """Measure current tasks only, reusing the progress already loaded for cards."""

    attempted = [item for item in progress if item.attempts > 0]
    tracked = len(attempted)
    retained = sum(item.streak >= 2 for item in attempted)
    lapsed = sum(item.correct_attempts > 0 and item.streak == 0 for item in attempted)
    return RetentionOut(
        tracked_positions=tracked,
        retained_positions=retained,
        lapsed_positions=lapsed,
        retention_rate=round(retained / tracked, 4) if tracked else None,
    )


async def _results_by_time_class(
    session: AsyncSession,
    *,
    username: str,
    color: str,
    time_class: str,
    min_user_rating: int,
) -> list[TimeClassResultOut]:
    filters = [
        Game.username == username,
        user_rating_condition(Game, min_user_rating),
    ]
    if color != "both":
        filters.append(Game.user_color == color)
    time_filter = time_class_condition(Game.time_class, time_class)
    if time_filter is not None:
        filters.append(time_filter)
    rows = await session.execute(
        select(
            Game.time_class,
            func.count(),
            func.coalesce(func.sum(case((Game.user_result == "win", 1), else_=0)), 0),
            func.coalesce(func.sum(case((Game.user_result == "draw", 1), else_=0)), 0),
        )
        .where(*filters)
        .group_by(Game.time_class)
    )
    results: list[TimeClassResultOut] = []
    for class_name, games, wins, draws in rows.all():
        total = int(games)
        if not total:
            continue
        won, drawn = int(wins or 0), int(draws or 0)
        lost = total - won - drawn
        results.append(
            TimeClassResultOut(
                time_class=class_name or "unknown",
                games=total,
                score_rate=round((won + 0.5 * drawn) / total, 4),
                win_rate=round(won / total, 4),
                draw_rate=round(drawn / total, 4),
                loss_rate=round(lost / total, 4),
            )
        )
    results.sort(key=lambda item: item.games, reverse=True)
    return results


async def _pattern_trends(
    session: AsyncSession,
    *,
    username: str,
    color: str,
    time_class: str,
    threshold_cp: int,
    min_depth: int,
    min_user_rating: int,
) -> list[PatternTrendOut]:
    """Compare evidence-backed mistake rates in the latest two 30-game windows."""

    cache = get_shared_cache()
    cache_key = (
        f"improvement:trends:v8:{username}:{color}:{time_class}:"
        f"{threshold_cp}:{min_depth}:{min_user_rating}"
    )
    cache_key = await cache.versioned_key(cache_key)
    cached = await cache.get_json(cache_key)
    if cached is not None:
        return [PatternTrendOut.model_validate(item) for item in cached]

    filters = [
        Game.username == username,
        user_rating_condition(Game, min_user_rating),
    ]
    if color != "both":
        filters.append(Game.user_color == color)
    time_filter = time_class_condition(Game.time_class, time_class)
    if time_filter is not None:
        filters.append(time_filter)
    latest_game_ids = (
        select(Game.id)
        .where(*filters)
        .order_by(Game.played_at.desc(), Game.id.desc())
        .limit(60)
        .subquery()
    )
    scoped_game_count = int(
        await session.scalar(select(func.count()).select_from(latest_game_ids)) or 0
    )
    recent_games = min(30, scoped_game_count)
    previous_games = min(30, max(0, scoped_game_count - 30))

    rows = (
        await session.execute(
            _TREND_ROWS_SQL,
            {
                "username": username,
                "color": color,
                "time_class": time_class,
                "threshold_cp": threshold_cp,
                "min_depth": min_depth,
                "min_user_rating": min_user_rating,
                "max_pair_depth_gap": MAX_PAIR_DEPTH_GAP,
            },
        )
    ).mappings().all()
    decisions = {"recent": 0, "previous": 0}
    total_decisions = {"recent": 0, "previous": 0}
    counts: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"label": "", "recent": 0, "previous": 0}
    )
    for row in rows:
        window = "recent" if int(row["game_rank"]) <= 30 else "previous"
        total_decisions[window] += 1
        if not row["analyzed"]:
            continue
        decisions[window] += 1
        eval_drop_cp = int(row["cp_loss"])
        if eval_drop_cp < threshold_cp or not row["best_move_uci"]:
            continue
        pattern = classify_pattern(
            fen=row["fen"],
            ply=int(row["ply"]),
            user_move_uci=row["user_move_uci"],
            best_move_uci=row["best_move_uci"],
            opponent_reply_uci=row["opponent_reply_uci"],
            parent_eval_cp=int(row["parent_eval_cp"]),
            mover_is_white=row["user_color"] == "white",
            eval_drop_cp=eval_drop_cp,
            user_move_san=row["user_move_san"] or row["user_move_uci"],
            best_move_san=move_san(
                row["fen"], row["best_move_uci"], row["best_move_san"]
            ),
            clock_seconds_after=row["clock_seconds_after"],
            think_seconds=row["think_seconds"],
            time_control=row["time_control"],
            best_pv_uci=row["best_pv_uci"],
            reply_pv_uci=row["reply_pv_uci"],
            best_eval_mate=row["parent_eval_mate"],
        )
        counts[pattern.key]["label"] = pattern.label
        counts[pattern.key][window] += 1

    trends: list[PatternTrendOut] = []
    minimum_decisions = min(decisions.values())
    for key, item in counts.items():
        recent_rate = (
            item["recent"] * 100 / recent_games if recent_games else 0.0
        )
        previous_rate = (
            item["previous"] * 100 / previous_games if previous_games else 0.0
        )
        delta = recent_rate - previous_rate
        status, confidence = trend_status(
            recent_occurrences=item["recent"],
            previous_occurrences=item["previous"],
            recent_rate=recent_rate,
            previous_rate=previous_rate,
            recent_games=recent_games,
            previous_games=previous_games,
            minimum_decisions=minimum_decisions,
            recent_missing_decisions=total_decisions["recent"] - decisions["recent"],
            previous_missing_decisions=total_decisions["previous"] - decisions["previous"],
        )
        trends.append(
            PatternTrendOut(
                key=key,
                label=item["label"],
                recent_occurrences=item["recent"],
                previous_occurrences=item["previous"],
                recent_rate_per_100_games=round(recent_rate, 1),
                previous_rate_per_100_games=round(previous_rate, 1),
                delta_per_100_games=round(delta, 1),
                status=status,
                confidence=confidence,
                recent_games=recent_games,
                previous_games=previous_games,
                recent_analyzed_decisions=decisions["recent"],
                previous_analyzed_decisions=decisions["previous"],
                recent_total_decisions=total_decisions["recent"],
                previous_total_decisions=total_decisions["previous"],
            )
        )
    trends.sort(
        key=lambda item: (
            item.status == "worsening",
            item.recent_occurrences,
            abs(item.delta_per_100_games),
        ),
        reverse=True,
    )
    await cache.set_json(
        cache_key,
        [item.model_dump(mode="json") for item in trends],
        ttl_seconds=300.0,
    )
    return trends


def _ranking_confidence(*, positions: int, recurrence: str,
                        analyzed_decisions: int, total_decisions: int) -> str:
    """Repeated examples establish a pattern, not representative coverage.

    Match the existing study-priority safeguards: a selectively analyzed or
    small corpus cannot support a confident overall recommendation. Separately
    validated time-window trends retain their own missing-evidence bounds.
    """
    if (analyzed_decisions < _MIN_ANALYSED_DECISIONS
            or analyzed_decisions != total_decisions):
        return "low"
    return "medium" if recurrence != "one_off" and positions >= 20 else "low"


def _stop_advice(
    analyzed_decisions: int, analyzed_by_phase: list[PhaseCoverageOut], *, total_decisions: int
) -> str:
    """Say what not to do — including not trusting a ranking built on thin evidence."""

    if analyzed_decisions < _MIN_ANALYSED_DECISIONS:
        return (
            "Do not narrow your study around this ranking yet; there is not enough personal evidence. "
            "Keep general practice alongside the available drills while more decisions are analyzed."
        )
    if analyzed_decisions < total_decisions:
        # A large absolute sample can still be selectively analyzed. Counts alone
        # do not establish that these patterns represent the player's whole game.
        return (
            f"Treat these study priorities as provisional: only "
            f"{analyzed_decisions / total_decisions:.1%} of your eligible decisions are analyzed. "
            "Practice the due positions, but do not rule out other study needs from this sample. "
            "Continue recent-game analysis to broaden the evidence."
        )
    if analyzed_by_phase:
        dominant = max(analyzed_by_phase, key=lambda phase: phase.share)
        under_measured = [
            phase.phase
            for phase in analyzed_by_phase
            if phase.share < _PHASE_BLIND_SHARE and phase.phase != dominant.phase
        ]
        # Ranking a player's weaknesses from one phase of the game and calling it
        # their profile is the easiest way for this tool to be confidently wrong.
        if dominant.share > _PHASE_SKEW_SHARE and under_measured:
            verb = "is" if len(under_measured) == 1 else "are"
            return (
                f"Do not read this as your whole game yet: {dominant.share:.0%} of your "
                f"analyzed decisions are in the {dominant.phase}, and your "
                f"{' and '.join(under_measured)} {verb} still severely under-measured. "
                "Leave browser "
                "analysis running to even that out."
            )
    return "Do not add unrelated study material this week; repeat the due positions first."


def _ensure_utc(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=UTC)


async def build_improvement_plan(
    session: AsyncSession,
    *,
    username: str,
    color: str = "both",
    time_class: str = DEFAULT_TIME_CLASS,
    threshold_cp: int = 80,
    min_depth: int = 18,
    limit: int = 20,
    min_user_rating: int = DEFAULT_MIN_USER_RATING,
    pattern_key: str | None = None,
) -> ImprovementPlanOut:
    candidate_read = _load_candidates(
        session,
        username=username,
        color=color,
        time_class=time_class,
        threshold_cp=threshold_cp,
        min_depth=min_depth,
        min_user_rating=min_user_rating,
    )
    coverage_kwargs = {
        "username": username,
        "color": color,
        "time_class": time_class,
        "min_depth": min_depth,
        "min_user_rating": min_user_rating,
    }
    trend_kwargs = {
        "username": username,
        "color": color,
        "time_class": time_class,
        "threshold_cp": threshold_cp,
        "min_depth": min_depth,
        "min_user_rating": min_user_rating,
    }
    now = datetime.now(UTC)
    is_postgresql = session.bind is not None and session.bind.dialect.name == "postgresql"
    speculative_reviews: list[dict[str, Any]] | None = None
    if is_postgresql:
        # The large cold reads share no transactional state, so each runs on its
        # own pooled session instead of one after another. Every evaluation the
        # crawler uploads (about every forty seconds) invalidates this plan, so
        # these reads are the common case, not a rare cold start. Tests use
        # SQLite's single in-memory connection, so that path stays sequential.
        has_due_review = await session.scalar(
            select(DrillProgress.id).where(
                DrillProgress.username == username,
                DrillProgress.attempts > 0,
                DrillProgress.due_at <= now,
            ).limit(1)
        ) is not None

        async def on_own_session(read):
            async with AsyncSession(bind=session.bind, expire_on_commit=False) as own:
                return await read(own)

        async def due_reviews(own: AsyncSession) -> list[dict[str, Any]]:
            # Unexcluded, because the discovery window it complements is not
            # known yet; overlapping positions are dropped once it is.
            return await _load_candidates(
                own, username=username, color=color, time_class=time_class,
                threshold_cp=threshold_cp, min_depth=min_depth,
                min_user_rating=min_user_rating, review_due_at=now,
            )

        async def no_reviews() -> None:
            return None

        raw_candidates, coverage, trends, speculative_reviews = await asyncio.gather(
            candidate_read,
            on_own_session(lambda own: _coverage(own, **coverage_kwargs)),
            on_own_session(lambda own: _pattern_trends(own, **trend_kwargs)),
            on_own_session(due_reviews) if has_due_review else no_reviews(),
        )
    else:
        raw_candidates = await candidate_read
        coverage = await _coverage(session, **coverage_kwargs)
        trends = await _pattern_trends(session, **trend_kwargs)
    candidate_limit_reached = len(raw_candidates) >= _CANDIDATE_SCAN_LIMIT
    position_ids = [item["position_id"] for item in raw_candidates]
    if candidate_limit_reached:
        seen = set(position_ids)
        if speculative_reviews is not None and len(speculative_reviews) < _CANDIDATE_SCAN_LIMIT:
            # Complete, so dropping the overlap gives exactly what the excluded
            # query below would have returned.
            reviews = [item for item in speculative_reviews if item["position_id"] not in seen]
        else:
            missing_due_review = await session.scalar(
                select(DrillProgress.id).where(
                    DrillProgress.username == username,
                    DrillProgress.position_id.not_in(position_ids),
                    DrillProgress.attempts > 0,
                    DrillProgress.due_at <= now,
                ).limit(1)
            )
            reviews = []
            if missing_due_review is not None:
                # Preserve spaced reviews outside the top-loss discovery window.
                # This second query stays bounded and uses the same game scope and
                # current engine evidence; obsolete answers cannot resurrect cards.
                reviews = await _load_candidates(
                    session, username=username, color=color, time_class=time_class,
                    threshold_cp=threshold_cp, min_depth=min_depth,
                    min_user_rating=min_user_rating, review_due_at=now,
                    excluded_positions=position_ids,
                )
        raw_candidates = [*raw_candidates, *reviews]
        position_ids.extend(item["position_id"] for item in reviews)
    # Mistakes from games against the engine opponent drill alongside the
    # imported ones: the post-game review already graded them, and a mistake
    # made in practice is as much the player's as one made on Chess.com.
    sparring = await _sparring_candidates(session, username=username, threshold_cp=threshold_cp)
    raw_candidates = [*sparring, *raw_candidates]
    position_ids = [*(item["position_id"] for item in sparring), *position_ids]
    progress_by_key: dict[tuple[int, str], DrillProgress] = {}
    if position_ids:
        progress_rows = await session.execute(
            select(DrillProgress).where(
                DrillProgress.username == username,
                DrillProgress.position_id.in_(position_ids),
            )
        )
        progress_by_key = {
            (row.position_id, row.expected_move_uci): row
            for row in progress_rows.scalars().all()
        }

    cards: list[tuple[float, DrillCardOut]] = []
    pattern_totals: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "label": "",
            "positions": 0,
            "occurrences": 0,
            "loss": 0,
            "observed_loss": 0,
            "worst": 0,
            "due": 0,
            "learned": 0,
        }
    )
    due_positions = 0
    habit_positions = 0
    one_off_positions = 0

    classified: list[tuple[dict[str, Any], str, dict[str, Any]]] = []
    # Several historical wrong moves can share one training position. Keep its
    # strongest example once, so neither sessions nor habit evidence count the
    # same board repeatedly as independent learning opportunities.
    seen_positions: set[int] = set()
    for item in raw_candidates:
        fen = item["fen"]
        analysis = item.get("analysis")
        if not fen or analysis is None:
            continue
        if item["position_id"] in seen_positions:
            continue
        seen_positions.add(item["position_id"])
        side_to_move = "white" if fen.split()[1] == "w" else "black"
        totals = pattern_totals[analysis["key"]]
        totals["label"] = analysis["label"]
        totals["positions"] += 1
        totals["occurrences"] += item["occurrences"]
        totals["loss"] += item["eval_drop_cp"]
        totals["observed_loss"] += item["eval_drop_cp"] * item["occurrences"]
        totals["worst"] = max(totals["worst"], item["eval_drop_cp"])
        classified.append((item, side_to_move, analysis))

    habit_keys = {
        key
        for key, value in pattern_totals.items()
        if value["positions"] >= _HABIT_MIN_POSITIONS
    }

    for item, side_to_move, analysis in classified:
        fen = item["fen"]
        if item["occurrences"] >= 2:
            recurrence = "repeated"
        elif analysis["key"] in habit_keys:
            recurrence = "habit"
        else:
            recurrence = "one_off"
        if recurrence == "one_off":
            one_off_positions += 1
        else:
            habit_positions += 1

        progress = progress_by_key.get((item["position_id"], item["best_move_uci"]))
        due_at = _ensure_utc(progress.due_at) if progress else None
        is_due = due_at is None or due_at <= now
        if is_due:
            due_positions += 1
            pattern_totals[analysis["key"]]["due"] += 1
        if progress is not None and progress.streak >= 2:
            pattern_totals[analysis["key"]]["learned"] += 1
        correct_rate = (
            round(progress.correct_attempts / progress.attempts, 4)
            if progress and progress.attempts
            else None
        )
        severity_bonus = min(item["eval_drop_cp"], 600)
        # A repeatable habit is worth more practice than a single spectacular
        # blunder the player is unlikely to meet again, so a one-off keeps its
        # place in the queue but stops leading it.
        habit_bonus = 250
        if recurrence == "one_off":
            severity_bonus *= 0.5
            habit_bonus = 0
        recurrence_bonus = min(item["occurrences"], 10) * 45
        learning_bonus = 180 if progress is None else (1.0 - (correct_rate or 0.0)) * 120
        due_bonus = 300 if is_due else -300
        score = severity_bonus + recurrence_bonus + habit_bonus + learning_bonus + due_bonus
        cards.append(
            (
                score,
                DrillCardOut(
                    position_id=item["position_id"],
                    fen=fen,
                    side_to_move=side_to_move,
                    user_move_san=item["user_move_san"],
                    user_move_uci=item["user_move_uci"],
                    best_move_san=item["best_move_san"] or item["best_move_uci"],
                    best_move_uci=item["best_move_uci"],
                    opponent_reply_uci=item.get("opponent_reply_uci"),
                    previous_move_uci=item.get("previous_move_uci"),
                    eval_drop_cp=item["eval_drop_cp"],
                    severity=classify_engine_drop(item["eval_drop_cp"]),
                    occurrences=item["occurrences"],
                    recurrence=recurrence,
                    pattern_key=analysis["key"],
                    pattern_label=analysis["label"],
                    phase=analysis["phase"],
                    explanation=analysis["explanation"],
                    cue=analysis["cue"],
                    follow_up=(
                        DrillFollowUpOut.model_validate(analysis["follow_up"])
                        if analysis["follow_up"]
                        else None
                    ),
                    motifs=[MotifOut.model_validate(motif) for motif in analysis["motifs"]],
                    source_game_id=item["source_game_id"],
                    source_game_url=item["source_game_url"],
                    source_played_at=datetime.fromisoformat(item["source_played_at"]),
                    time_class=item["time_class"],
                    clock_seconds_after=item.get("clock_seconds_after"),
                    think_seconds=item.get("think_seconds"),
                    attempts=progress.attempts if progress else 0,
                    correct_rate=correct_rate,
                    due_at=due_at,
                ),
            )
        )

    cards.sort(key=lambda pair: pair[0], reverse=True)
    due_cards = [card for _, card in cards if card.due_at is None or card.due_at <= now]

    total_decisions, analyzed_decisions, analyzed_by_phase = coverage
    # Lifetime effort must not disappear when rankings, filters or engine
    # answers change. Aggregate compact per-task state in SQL, not the full
    # attempt log or only the current candidate window. Retention below still
    # describes current, valid tasks rather than obsolete answers.
    attempts, correct_attempts = (await session.execute(
        select(
            func.coalesce(func.sum(DrillProgress.attempts), 0),
            func.coalesce(func.sum(DrillProgress.correct_attempts), 0),
        ).where(DrillProgress.username == username)
    )).one()
    drill_rows = await session.execute(
        select(
            DrillAttempt.pattern_key,
            func.count(),
            func.coalesce(func.sum(DrillAttempt.correct), 0),
        )
        .where(
            DrillAttempt.username == username,
            DrillAttempt.position_id.in_(position_ids),
        )
        .group_by(DrillAttempt.pattern_key)
    )
    drills_by_pattern = {
        key: (int(total), int(correct or 0)) for key, total, correct in drill_rows.all()
    }
    patterns = [
        PatternSummaryOut(
            key=key,
            label=value["label"],
            positions=value["positions"],
            occurrences=value["occurrences"],
            average_loss_cp=round(value["loss"] / value["positions"]),
            worst_loss_cp=value["worst"],
            drill_attempts=drills_by_pattern.get(key, (0, 0))[0],
            drill_correct_rate=(
                round(drills_by_pattern[key][1] / drills_by_pattern[key][0], 4)
                if drills_by_pattern.get(key, (0, 0))[0]
                else None
            ),
            due_positions=value["due"],
            learned_positions=value["learned"],
            recurrence=(
                "habit"
                if value["positions"] >= _HABIT_MIN_POSITIONS
                else ("repeated" if value["occurrences"] > value["positions"] else "one_off")
            ),
        )
        for key, value in pattern_totals.items()
    ]
    # Habits first, then balance expected loss against independent support. This
    # same score is evaluated on time-ordered holdouts in ranking_eval.py.
    patterns.sort(
        key=lambda item: pattern_priority_key(
            total_loss_cp=pattern_totals[item.key]["observed_loss"],
            occurrences=item.occurrences,
            positions=item.positions,
        ),
        reverse=True,
    )
    insights, opening_priorities = await _outcome_context(
        session,
        username=username,
        color=color,
        time_class=time_class,
        min_user_rating=min_user_rating,
    )
    current_progress = [
        progress
        for _, card in cards
        if (progress := progress_by_key.get((card.position_id, card.best_move_uci))) is not None
    ]
    retention = _retention(current_progress)
    results_by_time_class = await _results_by_time_class(
        session,
        username=username,
        color=color,
        time_class=time_class,
        min_user_rating=min_user_rating,
    )
    weak_pattern_keys = {
        trend.key for trend in trends if trend.status == "worsening"
    } or {pattern.key for pattern in patterns[:2]}
    eligible_cards = (
        [card for card in due_cards if card.pattern_key == pattern_key]
        if pattern_key
        else due_cards
    )
    selected_cards = compose_session(
        eligible_cards, weak_pattern_keys=weak_pattern_keys, limit=limit
    )
    session_seconds = sum(_drill_seconds(card) for card in selected_cards)

    worsening_trend = next((trend for trend in trends if trend.status == "worsening"), None)
    focus_key = worsening_trend.key if worsening_trend else (patterns[0].key if patterns else None)
    focus_label = (
        worsening_trend.label
        if worsening_trend
        else (patterns[0].label if patterns else "Analysis coverage")
    )
    focus_card = next((card for _, card in cards if card.pattern_key == focus_key), None)
    if worsening_trend:
        evidence = (
            f"{worsening_trend.previous_rate_per_100_games:.1f} to "
            f"{worsening_trend.recent_rate_per_100_games:.1f} errors per 100 games "
            "across the latest two 30-game windows."
        )
        confidence = worsening_trend.confidence
    elif patterns:
        top = patterns[0]
        if top.recurrence == "habit":
            evidence = (
                f"{top.occurrences} occurrences across {top.positions} different positions, "
                "so this is a repeated habit rather than one bad game."
            )
        elif top.recurrence == "repeated":
            evidence = (
                f"{top.occurrences} occurrences across {top.positions} analyzed mistake "
                "positions, so the same decision went wrong more than once."
            )
        else:
            evidence = (
                f"A single occurrence losing {top.worst_loss_cp / 100:.1f} pawns. "
                "No repeated habit has enough evidence yet."
            )
        confidence = _ranking_confidence(
            positions=top.positions, recurrence=top.recurrence,
            analyzed_decisions=analyzed_decisions, total_decisions=total_decisions,
        )
    else:
        evidence = "There are not enough adjacent evaluated positions to rank a mistake yet."
        confidence = "low"
    if patterns and not worsening_trend and analyzed_decisions < total_decisions:
        evidence += (
            f" This ranking covers {analyzed_decisions:,} of {total_decisions:,} eligible decisions "
            f"({analyzed_decisions / total_decisions:.1%}), not your complete game history."
        )
    prescription = WeeklyPrescriptionOut(
        focus=focus_label,
        evidence=evidence,
        action=(
            focus_card.cue
            if focus_card is not None
            else (
                "Import your Rapid and Blitz games first, then start browser analysis."
                if total_decisions == 0
                else "Run recent-game analysis, then solve the first due positions without engine hints."
            )
        ),
        stop=_stop_advice(analyzed_decisions, analyzed_by_phase, total_decisions=total_decisions),
        confidence=confidence,
    )

    return ImprovementPlanOut(
        username=username,
        color=color,
        time_class=time_class,
        min_user_rating=min_user_rating,
        summary=ImprovementSummaryOut(
            candidate_positions=len(cards),
            candidate_positions_is_lower_bound=candidate_limit_reached,
            habit_positions=habit_positions,
            one_off_positions=one_off_positions,
            session_seconds=session_seconds,
            due_positions=due_positions,
            analyzed_decisions=analyzed_decisions,
            total_decisions=total_decisions,
            analyzed_by_phase=analyzed_by_phase,
            coverage_rate=round(analyzed_decisions / total_decisions, 4)
            if total_decisions
            else 0.0,
            attempts=attempts,
            correct_rate=round(correct_attempts / attempts, 4) if attempts else None,
            patterns=patterns,
            insights=insights,
            opening_priorities=opening_priorities,
            trends=trends,
            retention=retention,
            results_by_time_class=results_by_time_class,
            prescription=prescription,
        ),
        drills=selected_cards,
        intents=list(DRILL_INTENTS),
    )


async def record_drill_attempt(
    session: AsyncSession,
    payload: DrillAttemptIn,
) -> DrillAttemptOut:
    # The parent lock also serializes creation of the initial progress row;
    # locking only existing progress would still race on the first attempt.
    position = await session.scalar(select(Position).where(Position.id == payload.position_id).with_for_update())
    if position is None:
        raise ValueError("Unknown training position")
    request_id = str(payload.request_id) if payload.request_id is not None else None
    fingerprint = None
    if request_id is not None:
        # The position lock serializes initial writes and retries for this
        # user/position/request key, including two overlapping first requests.
        content = payload.model_dump(mode="json", exclude={"request_id"})
        content["username"] = payload.username.lower()
        content["continuation_supplied"] = "expected_follow_up" in payload.model_fields_set
        fingerprint = hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()
        receipt = await session.scalar(select(DrillAttempt).where(
            DrillAttempt.username == payload.username,
            DrillAttempt.position_id == payload.position_id,
            DrillAttempt.request_id == request_id,
        ))
        if receipt is not None:
            # Pre-identity-migration receipts hashed the original spelling.
            legacy_content = {**content, "username": receipt.username}
            legacy_fingerprint = hashlib.sha256(json.dumps(legacy_content, sort_keys=True).encode()).hexdigest()
            if receipt.request_fingerprint not in {fingerprint, legacy_fingerprint} or receipt.result_snapshot is None:
                raise ValueError("This request ID was already used for a different answer")
            return DrillAttemptOut.model_validate(receipt.result_snapshot)
    expected = await session.scalar(
        select(AnalysisResult)
        .where(
            AnalysisResult.position_id == payload.position_id,
            AnalysisResult.engine == ENGINE_NAME,
            AnalysisResult.engine_version == ENGINE_VERSION,
            AnalysisResult.multipv_rank == 1,
            AnalysisResult.depth >= 18,
        )
        .order_by(AnalysisResult.depth.desc(), AnalysisResult.id.desc())
        .limit(1)
    )
    if expected is None or expected.best_move_uci != payload.expected_move_uci:
        raise ValueError("The expected move is stale; refresh the training queue")

    follow_up = build_follow_up(position.fen, expected.pv_uci)
    if "expected_follow_up" in payload.model_fields_set:
        def continuation_key(value: DrillFollowUpOut | None):
            if value is None:
                return None
            return (
                " ".join(value.fen.split()[:4]),
                value.opponent_reply_uci,
                value.best_move_uci,
            )

        if continuation_key(payload.expected_follow_up) != continuation_key(follow_up):
            # Never grade an answer to a different board or silently add a
            # second question after the learner started a one-move lesson.
            raise ValueError("The continuation is stale; refresh the training queue")

    board = chess.Board(_as_full_fen(position.fen))
    if _legal_move(board, payload.played_move_uci) is None:
        raise ValueError("The submitted move is not legal in this position")

    now = datetime.now(UTC)
    acceptable_moves = {payload.expected_move_uci}
    if expected.eval_cp is not None:
        alternate_rows = await session.execute(
            select(AnalysisResult.best_move_uci, AnalysisResult.eval_cp).where(
                AnalysisResult.position_id == payload.position_id,
                AnalysisResult.engine == expected.engine,
                AnalysisResult.engine_version == ENGINE_VERSION,
                AnalysisResult.depth == expected.depth,
                AnalysisResult.best_move_uci.is_not(None),
                AnalysisResult.eval_cp.is_not(None),
            )
        )
        acceptable_moves.update(
            move_uci
            for move_uci, eval_cp in alternate_rows.all()
            if move_uci is not None
            and eval_cp is not None
            and abs(eval_cp - expected.eval_cp) <= _ACCEPTANCE_BAND_CP
            and _legal_move(board, move_uci) is not None
        )
    correct = payload.played_move_uci in acceptable_moves or _delivers_checkmate(
        board, payload.played_move_uci
    )
    intent_matched, intent_feedback = compare_intent(payload.intent_key, payload.pattern_key)
    follow_up_correct: bool | None = None
    if follow_up is not None and payload.played_move_uci == expected.best_move_uci:
        follow_up_board = chess.Board(follow_up.fen)
        if payload.follow_up_move_uci is not None and _legal_move(follow_up_board, payload.follow_up_move_uci) is None:
            # Transport/stale-board errors are not evidence of failed recall.
            # Apply the same legality gate as the first answer before writing progress.
            raise ValueError("The submitted follow-up move is not legal in this position")
        follow_up_correct = (
            payload.follow_up_move_uci == follow_up.best_move_uci
            or _delivers_checkmate(follow_up_board, payload.follow_up_move_uci)
        )
        # Omitting the second half must not mark a two-move lesson as learned.
        correct = correct and follow_up_correct
    elif payload.follow_up_move_uci is not None:
        raise ValueError("The follow-up does not belong to the submitted first move")
    progress = await session.scalar(
        select(DrillProgress).where(
            DrillProgress.username == payload.username,
            DrillProgress.position_id == payload.position_id,
            DrillProgress.expected_move_uci == payload.expected_move_uci,
        )
    )
    if progress is None:
        progress = DrillProgress(
            username=payload.username,
            position_id=payload.position_id,
            expected_move_uci=payload.expected_move_uci,
            attempts=0,
            correct_attempts=0,
            streak=0,
            interval_days=0,
            ease_factor=2.0,
            due_at=now,
        )
        session.add(progress)

    next_streak, next_interval, next_ease, due_at = next_review(
        now=now,
        correct=correct,
        streak=progress.streak,
        interval_days=progress.interval_days,
        ease_factor=progress.ease_factor,
    )
    if correct and progress.streak > 0 and (_ensure_utc(progress.due_at) or now) > now:
        # Immediate repetition measures recall of the just-shown answer, not
        # retention. Record the attempt but advance mastery only when due.
        next_streak = progress.streak
        next_interval = progress.interval_days
        next_ease = progress.ease_factor
        due_at = _ensure_utc(progress.due_at) or now
    progress.attempts += 1
    progress.correct_attempts += int(correct)
    progress.streak = next_streak
    progress.interval_days = next_interval
    progress.ease_factor = next_ease
    progress.due_at = due_at
    progress.last_attempt_at = now
    result = DrillAttemptOut(
        correct=correct,
        follow_up_correct=follow_up_correct,
        intent_matched=intent_matched,
        intent_feedback=intent_feedback,
        attempts=progress.attempts,
        correct_attempts=progress.correct_attempts,
        streak=progress.streak,
        interval_days=progress.interval_days,
        due_at=progress.due_at,
    )
    session.add(
        DrillAttempt(
            username=payload.username,
            position_id=payload.position_id,
            expected_move_uci=payload.expected_move_uci,
            played_move_uci=payload.played_move_uci,
            pattern_key=payload.pattern_key,
            intent_key=payload.intent_key,
            correct=int(correct),
            response_ms=payload.response_ms,
            request_id=request_id,
            request_fingerprint=fingerprint,
            result_snapshot=result.model_dump(mode="json") if request_id else None,
            attempted_at=now,
        )
    )
    await session.flush()
    # Candidate caches contain game/evaluation facts only. Progress, retention,
    # and attempt statistics are queried live by build_improvement_plan, so an
    # answer need not trigger another expensive scan of historical games.
    return result
