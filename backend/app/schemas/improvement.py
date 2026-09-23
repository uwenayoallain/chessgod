from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class MotifOut(BaseModel):
    """A tactic named from board geometry, with the fact that proves it."""

    key: str
    label: str
    detail: str
    side: str


class PatternSummaryOut(BaseModel):
    key: str
    label: str
    positions: int
    occurrences: int
    average_loss_cp: int
    worst_loss_cp: int
    drill_attempts: int = 0
    drill_correct_rate: float | None = None
    due_positions: int = 0
    learned_positions: int = 0
    # "habit" spans several different positions, "repeated" is the same position
    # played wrong more than once, "one_off" happened exactly once.
    recurrence: str


class PhaseCoverageOut(BaseModel):
    """Where in the game the evidence actually is."""

    phase: str
    analyzed_decisions: int
    share: float


class RetentionOut(BaseModel):
    """Whether corrections stick, measured from spaced-repetition streaks."""

    tracked_positions: int
    retained_positions: int  # answered correctly at least twice in a row
    lapsed_positions: int  # previously correct, currently back at a zero streak
    retention_rate: float | None = None


class TimeClassResultOut(BaseModel):
    time_class: str
    games: int
    score_rate: float
    win_rate: float
    draw_rate: float
    loss_rate: float


class OutcomeInsightOut(BaseModel):
    key: str
    label: str
    detail: str
    occurrences: int
    sample_games: int
    rate: float
    cue: str


class OpeningPriorityOut(BaseModel):
    opening_name: str
    time_class: str
    games: int
    score_rate: float


class PatternTrendOut(BaseModel):
    key: str
    label: str
    recent_occurrences: int
    previous_occurrences: int
    recent_rate_per_100_games: float
    previous_rate_per_100_games: float
    delta_per_100_games: float
    status: str
    confidence: str
    recent_games: int
    previous_games: int
    recent_analyzed_decisions: int
    previous_analyzed_decisions: int
    # Rates are observed error counts per 100 games, not estimates of missing
    # evaluations. Totals expose the evidence gap used to gate trend claims.
    recent_total_decisions: int
    previous_total_decisions: int


class WeeklyPrescriptionOut(BaseModel):
    focus: str
    evidence: str
    action: str
    stop: str
    confidence: str


class DrillIntentOut(BaseModel):
    """A thinking routine the player can claim before the answer is shown."""

    key: str
    label: str
    prompt: str


class DrillFollowUpOut(BaseModel):
    """The second half of a calculation drill, replayed from the stored best line."""

    fen: str
    opponent_reply_uci: str
    opponent_reply_san: str
    best_move_uci: str
    best_move_san: str


class DrillCardOut(BaseModel):
    position_id: int
    fen: str
    side_to_move: str
    user_move_san: str
    user_move_uci: str
    best_move_san: str
    best_move_uci: str
    opponent_reply_uci: str | None = None
    # The move that led to `fen`; null when the position opens the game.
    previous_move_uci: str | None = None
    eval_drop_cp: int
    severity: str
    occurrences: int
    recurrence: str
    # Why this card is in the session: review, recent, weak, transfer, or ranked.
    queue_source: str = "ranked"
    pattern_key: str
    pattern_label: str
    phase: str
    explanation: str
    cue: str
    motifs: list[MotifOut] = Field(default_factory=list)
    follow_up: DrillFollowUpOut | None = None
    source_game_id: int
    source_game_url: str
    source_played_at: datetime
    time_class: str
    clock_seconds_after: float | None = None
    think_seconds: float | None = None
    attempts: int = 0
    correct_rate: float | None = None
    due_at: datetime | None = None


class ImprovementSummaryOut(BaseModel):
    candidate_positions: int
    candidate_positions_is_lower_bound: bool
    habit_positions: int
    one_off_positions: int
    # Estimated length of the composed drill set, in seconds.
    session_seconds: int
    due_positions: int
    # The player's own moves, and how many have a trusted evaluation on both sides.
    analyzed_decisions: int
    total_decisions: int
    analyzed_by_phase: list[PhaseCoverageOut]
    coverage_rate: float
    # Lifetime user totals, independent of current filters/candidate selection.
    attempts: int
    correct_rate: float | None = None
    patterns: list[PatternSummaryOut]
    insights: list[OutcomeInsightOut]
    opening_priorities: list[OpeningPriorityOut]
    trends: list[PatternTrendOut]
    retention: RetentionOut
    results_by_time_class: list[TimeClassResultOut]
    prescription: WeeklyPrescriptionOut


class ImprovementPlanOut(BaseModel):
    username: str
    color: str
    time_class: str
    min_user_rating: int
    summary: ImprovementSummaryOut
    drills: list[DrillCardOut]
    intents: list[DrillIntentOut]


class DrillAttemptIn(BaseModel):
    request_id: UUID | None = None
    username: str
    position_id: int
    expected_move_uci: str
    played_move_uci: str
    pattern_key: str
    # What the player said they were checking, from the plan's intent list.
    intent_key: str | None = None
    # Sent only when the card carried a follow-up and the first move matched it.
    follow_up_move_uci: str | None = None
    # The continuation displayed when the attempt began. Explicit null means
    # a one-move card; omission preserves compatibility with older clients.
    expected_follow_up: DrillFollowUpOut | None = None
    response_ms: int | None = Field(default=None, ge=0, le=3_600_000)


class DrillAttemptOut(BaseModel):
    correct: bool
    # None when the attempt carried no second move to score.
    follow_up_correct: bool | None = None
    # None when the player stated no intended thought process.
    intent_matched: bool | None = None
    intent_feedback: str | None = None
    attempts: int
    correct_attempts: int
    streak: int
    interval_days: int
    due_at: datetime
