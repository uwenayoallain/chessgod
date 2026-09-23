"""Offline evaluation of the drill-queue ranking on time-ordered holdout games.

A ranking that is tuned and then scored on the same games it was built from will
always look good. This harness splits a player's games by date, builds the ranking
from the older half only, and asks a single question of the newer games the ranking
never saw: how much of the evaluation loss the player actually went on to give away
belongs to the patterns the ranking chose to train?
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.services.game_scope import DEFAULT_MIN_USER_RATING, time_class_condition, user_rating_condition
from app.services.improvement import (
    DEFAULT_TIME_CLASS,
    _CANDIDATE_SCAN_LIMIT,
    _load_candidates,
    pattern_priority_key,
)


DEFAULT_HOLDOUT_FRACTION = 0.25
DEFAULT_TOP_K = 3
# A single split swings wildly once the holdout is small: measured on the first
# real corpus, splits with 36-70 holdout positions produced lifts from +41% to
# -36% for the same ranking. Refuse those, and average over several origins.
MIN_HOLDOUT_POSITIONS = 150
MIN_TRAIN_POSITIONS = 150
# Seven rolling origins. The older three were held aside while the current
# risk/evidence score was selected, so the default report preserves both the
# development windows and independent validation windows.
DEFAULT_FRACTIONS = (0.45, 0.40, 0.35, 0.30, 0.25, 0.20, 0.15)


@dataclass(frozen=True)
class RankingEvaluation:
    username: str
    cutoff: datetime | None
    train_games: int
    holdout_games: int
    train_positions: int
    holdout_positions: int
    top_patterns: list[str] = field(default_factory=list)
    holdout_loss_cp: int = 0
    covered_loss_cp: int = 0
    coverage: float = 0.0
    baseline_coverage: float = 0.0
    lift: float = 0.0
    verdict: str = "insufficient"


async def _window_losses(
    session: AsyncSession,
    *,
    username: str,
    color: str,
    time_class: str,
    threshold_cp: int,
    min_depth: int,
    played_before: datetime | None = None,
    played_from: datetime | None = None,
    complete: bool = False,
) -> tuple[dict[str, dict[str, int]], int]:
    """Observed loss, occurrences and independent positions per pattern."""

    async def candidates():
        offset = 0
        while True:
            batch = await _load_candidates(
                session, username=username, color=color, time_class=time_class,
                threshold_cp=threshold_cp, min_depth=min_depth,
                played_before=played_before, played_from=played_from,
                scan_offset=offset, cache_results=False,
            )
            for item in batch:
                yield item
            if not complete or len(batch) < _CANDIDATE_SCAN_LIMIT:
                return
            offset += _CANDIDATE_SCAN_LIMIT
    evidence: dict[str, dict[str, int]] = defaultdict(
        lambda: {"loss": 0, "occurrences": 0, "positions": 0}
    )
    positions = 0
    seen_positions: set[int] = set()
    async for item in candidates():
        analysis = item.get("analysis")
        if analysis is None:
            continue
        if item["position_id"] in seen_positions:
            continue
        seen_positions.add(item["position_id"])
        pattern = evidence[analysis["key"]]
        pattern["loss"] += item["eval_drop_cp"] * item["occurrences"]
        pattern["occurrences"] += item["occurrences"]
        pattern["positions"] += 1
        positions += 1
    return dict(evidence), positions


async def evaluate_ranking(
    session: AsyncSession,
    *,
    username: str,
    color: str = "both",
    time_class: str = DEFAULT_TIME_CLASS,
    threshold_cp: int = 80,
    min_depth: int = 18,
    holdout_fraction: float = DEFAULT_HOLDOUT_FRACTION,
    top_k: int = DEFAULT_TOP_K,
    min_holdout_positions: int = MIN_HOLDOUT_POSITIONS,
    min_train_positions: int = MIN_TRAIN_POSITIONS,
) -> RankingEvaluation:
    if not 0 < holdout_fraction < 1:
        raise ValueError("holdout_fraction must be strictly between zero and one")
    if top_k < 1:
        raise ValueError("top_k must be positive")
    if min_train_positions < 1 or min_holdout_positions < 1:
        raise ValueError("Minimum training and holdout position counts must be positive")
    filters = [Game.username == username, user_rating_condition(Game, DEFAULT_MIN_USER_RATING)]
    if color != "both":
        filters.append(Game.user_color == color)
    time_filter = time_class_condition(Game.time_class, time_class)
    if time_filter is not None:
        filters.append(time_filter)

    total_games = int(await session.scalar(select(func.count()).where(*filters)) or 0)
    holdout_games = int(total_games * holdout_fraction)
    if total_games < 4 or holdout_games < 1:
        return RankingEvaluation(
            username=username,
            cutoff=None,
            train_games=total_games,
            holdout_games=0,
            train_positions=0,
            holdout_positions=0,
        )

    # The cutoff is the played_at of the oldest holdout game, so the split is by
    # time rather than by a shuffled sample the ranking could have leaked into.
    cutoff = await session.scalar(
        select(Game.played_at)
        .where(*filters)
        .order_by(Game.played_at.desc(), Game.id.desc())
        .offset(holdout_games - 1)
        .limit(1)
    )
    if cutoff is None:
        return RankingEvaluation(
            username=username,
            cutoff=None,
            train_games=total_games,
            holdout_games=0,
            train_positions=0,
            holdout_positions=0,
        )

    # Date predicates include every game tied at the cutoff. Report the actual
    # windows, not the requested fraction's row count.
    holdout_games = int(await session.scalar(
        select(func.count()).where(*filters, Game.played_at >= cutoff)
    ) or 0)

    train_evidence, train_positions = await _window_losses(
        session,
        username=username,
        color=color,
        time_class=time_class,
        threshold_cp=threshold_cp,
        min_depth=min_depth,
        played_before=cutoff,
    )
    holdout_evidence, holdout_positions = await _window_losses(
        session,
        username=username,
        color=color,
        time_class=time_class,
        threshold_cp=threshold_cp,
        min_depth=min_depth,
        played_from=cutoff,
        complete=True,
    )

    top_patterns = [
        key
        for key, _ in sorted(
            train_evidence.items(),
            key=lambda item: (
                pattern_priority_key(
                    total_loss_cp=item[1]["loss"],
                    occurrences=item[1]["occurrences"],
                    positions=item[1]["positions"],
                ),
                item[0],
            ),
            reverse=True,
        )
    ][:top_k]
    holdout_loss = sum(item["loss"] for item in holdout_evidence.values())
    covered = sum(holdout_evidence.get(key, {}).get("loss", 0) for key in top_patterns)
    coverage = covered / holdout_loss if holdout_loss else 0.0
    # A blind comparator must choose from the same training-time options as the
    # ranker, not from future patterns it could not have known. Each available
    # pattern has selected_count / distinct probability of being picked.
    distinct = len(train_evidence)
    available_loss = sum(holdout_evidence.get(key, {}).get("loss", 0) for key in train_evidence)
    baseline = (
        (len(top_patterns) / distinct) * (available_loss / holdout_loss)
        if distinct and holdout_loss else 0.0
    )
    lift = coverage - baseline

    if (
        not train_evidence
        or not holdout_evidence
        or holdout_positions < min_holdout_positions
        or train_positions < min_train_positions
    ):
        verdict = "insufficient"
    elif lift > 0.05:
        verdict = "better than chance"
    elif lift < -0.05:
        verdict = "worse than chance"
    else:
        verdict = "no better than chance"

    return RankingEvaluation(
        username=username,
        cutoff=cutoff,
        train_games=total_games - holdout_games,
        holdout_games=holdout_games,
        train_positions=train_positions,
        holdout_positions=holdout_positions,
        top_patterns=top_patterns,
        holdout_loss_cp=holdout_loss,
        covered_loss_cp=covered,
        coverage=round(coverage, 4),
        baseline_coverage=round(baseline, 4),
        lift=round(lift, 4),
        verdict=verdict,
    )


@dataclass(frozen=True)
class RollingRankingEvaluation:
    """Several time-ordered splits, so one lucky origin cannot decide a verdict."""

    username: str
    splits: list[RankingEvaluation] = field(default_factory=list)
    usable_splits: int = 0
    mean_lift: float = 0.0
    worst_lift: float = 0.0
    verdict: str = "insufficient"


async def evaluate_ranking_rolling(
    session: AsyncSession,
    *,
    username: str,
    color: str = "both",
    time_class: str = DEFAULT_TIME_CLASS,
    threshold_cp: int = 80,
    min_depth: int = 18,
    top_k: int = DEFAULT_TOP_K,
    fractions: tuple[float, ...] = DEFAULT_FRACTIONS,
) -> RollingRankingEvaluation:
    splits = [
        await evaluate_ranking(
            session,
            username=username,
            color=color,
            time_class=time_class,
            threshold_cp=threshold_cp,
            min_depth=min_depth,
            holdout_fraction=fraction,
            top_k=top_k,
        )
        for fraction in fractions
    ]
    # Different requested fractions can land on the same timestamp (especially
    # with tied games). Repeating that window is not new validation evidence and
    # must neither satisfy the two-origin gate nor give its lift extra weight.
    usable_by_cutoff = {
        split.cutoff: split for split in splits
        if split.verdict != "insufficient" and split.cutoff is not None
    }
    usable = list(usable_by_cutoff.values())
    if len(usable) < 2:
        return RollingRankingEvaluation(username=username, splits=splits, usable_splits=len(usable))

    lifts = [split.lift for split in usable]
    mean_lift = sum(lifts) / len(lifts)
    worst_lift = min(lifts)
    # A ranking only earns "better than chance" when it beats a blind pick on
    # average *and* never loses to one on any origin.
    if mean_lift > 0.05 and worst_lift > 0:
        verdict = "better than chance"
    elif mean_lift < -0.05:
        verdict = "worse than chance"
    else:
        verdict = "no better than chance"
    return RollingRankingEvaluation(
        username=username,
        splits=splits,
        usable_splits=len(usable),
        mean_lift=round(mean_lift, 4),
        worst_lift=round(worst_lift, 4),
        verdict=verdict,
    )
