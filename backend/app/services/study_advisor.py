"""Personalized Study Coach: maps a player's real game leaks to master playbooks.

Reads the player's actual last-12-month opening records, where-points-go phase
and move-kind loss shares, recurring opening fixes, and over-the-board habits,
then ranks the exact Master Playbooks, Chess.com Premium courses, books, and
free modern resources that address their biggest rating leaks.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import Integer, Text, bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.database import _async_engine_for
from app.models.identity import Username
from app.schemas.improvement import PointsLostOut
from app.services.cache import get_shared_cache
from app.services.habits import build_habits
from app.services.points_lost import build_points_lost
from app.services.study_curriculum import PLAYBOOK_BY_ID, PLAYBOOKS, MasterPlaybook
from app.services.swr import _publish

OPENING_LOOKBACK_DAYS = 365
MIN_OPENING_GAMES = 10

_OPENING_STATS_SQL = """
SELECT g.user_color,
       COALESCE(g.eco, '') AS eco,
       COALESCE(g.opening_name, '') AS opening_name,
       COUNT(*) AS games,
       SUM(CASE WHEN g.user_result = 'win' THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN g.user_result = 'draw' THEN 1 ELSE 0 END) AS draws,
       SUM(CASE WHEN g.user_result = 'loss' THEN 1 ELSE 0 END) AS losses
FROM games g
WHERE g.username = :username
  AND (
      (:time_class = 'rapid_blitz' AND g.time_class IN ('rapid', 'blitz'))
      OR g.time_class = :time_class
  )
  AND CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END >= :min_user_rating
  AND g.played_at >= :since
GROUP BY g.user_color, COALESCE(g.eco, ''), COALESCE(g.opening_name, '')
"""

_LATEST_RATING_SQL = """
SELECT g.time_class,
       CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END AS rating
FROM games g
WHERE g.username = :username
  AND (
      (:time_class = 'rapid_blitz' AND g.time_class IN ('rapid', 'blitz'))
      OR g.time_class = :time_class
  )
ORDER BY g.played_at DESC, g.id DESC
LIMIT 1
"""


# Match the TTLs the Where-your-points-go and Habits endpoints publish with.
_POINTS_FRESH_SECONDS = 1_800.0
_HABITS_FRESH_SECONDS = 1_800.0
_LAST_KNOWN_SECONDS = 86_400.0


async def _fresh_or_build(
    fresh_base: str,
    last_key: str,
    compute: Callable[[], Awaitable[Any]],
    fresh_ttl: float,
) -> Any:
    """Reuse a fresh shared-cache entry, else build it and publish it for its own page.

    Only a fresh copy is reused, never the last-known one, so the guide is
    built from the same evidence a cold build would read. Publication goes
    through the same generation check as `stale_while_revalidate`, so an
    upload that lands mid-build cannot be overwritten by an older answer.
    """
    cache = get_shared_cache()
    last_key = last_key.lower()
    fresh_key = await cache.versioned_key(fresh_base)
    cached = await cache.get_json(fresh_key)
    if cached is not None:
        return cached
    last_generation = await cache.versioned_key(last_key)
    value = await compute()
    await _publish(
        cache, fresh_base, fresh_key, last_key, last_generation, value, fresh_ttl, _LAST_KNOWN_SECONDS,
    )
    return value


def serialize_playbook(playbook: MasterPlaybook) -> dict[str, Any]:
    """Convert a MasterPlaybook dataclass into a JSON-safe dictionary."""
    data = asdict(playbook)
    for key in (
        "core_ideas",
        "white_plans",
        "black_plans",
        "key_breaks",
        "piece_guide",
        "checklist",
        "common_traps",
        "eco_prefixes",
        "opening_keywords",
        "books",
        "courses",
    ):
        data[key] = list(data[key])
    return data


def _match_opening_playbook(user_color: str, eco: str, opening_name: str) -> MasterPlaybook | None:
    """Find the most specific opening playbook matching a player's ECO + color."""
    eco_upper = (eco or "").strip().upper()
    name_lower = (opening_name or "").strip().lower()
    # First prefer exact color + keyword match (handles e.g. London vs QGD on D00/D02).
    for playbook in PLAYBOOKS:
        if playbook.category != "opening":
            continue
        if playbook.color != "both" and playbook.color != user_color:
            continue
        if playbook.opening_keywords and any(kw in name_lower for kw in playbook.opening_keywords):
            return playbook
    # Next fall back to exact color + ECO prefix match.
    for playbook in PLAYBOOKS:
        if playbook.category != "opening":
            continue
        if playbook.color != "both" and playbook.color != user_color:
            continue
        if eco_upper and any(eco_upper.startswith(prefix) for prefix in playbook.eco_prefixes):
            return playbook
    return None


def _format_pct(value: float) -> str:
    return f"{round(value * 100, 1):.1f}%"


async def build_study_guide(
    session: AsyncSession,
    *,
    username: str,
    time_class: str = "rapid_blitz",
    min_user_rating: int = 0,
) -> dict[str, Any]:
    """Build a personalized weakness-matched Study Guide + full Master Playbook catalog."""
    since = datetime.now(UTC) - timedelta(days=OPENING_LOOKBACK_DAYS)

    opening_stmt = text(_OPENING_STATS_SQL).bindparams(
        bindparam("username", type_=Username),
        bindparam("time_class", type_=Text()),
        bindparam("min_user_rating", type_=Integer()),
    )
    rating_stmt = text(_LATEST_RATING_SQL).bindparams(
        bindparam("username", type_=Username),
        bindparam("time_class", type_=Text()),
    )

    async def openings(db: AsyncSession) -> tuple[list[Any], Any]:
        rows = (
            await db.execute(
                opening_stmt,
                {
                    "username": username,
                    "time_class": time_class,
                    "min_user_rating": min_user_rating,
                    "since": since,
                },
            )
        ).mappings().all()
        latest = (
            await db.execute(rating_stmt, {"username": username, "time_class": time_class})
        ).mappings().first()
        return list(rows), latest

    async def points_payload(db: AsyncSession) -> dict:
        result = await build_points_lost(
            db,
            username=username,
            color="both",
            time_class=time_class,
            min_user_rating=min_user_rating,
        )
        return result.model_dump(mode="json")

    async def habits_payload(db: AsyncSession) -> dict:
        return await build_habits(db, username=username, min_user_rating=min_user_rating)

    # The same cache entries the Where-your-points-go and Habits pages fill, so
    # whichever page is opened first pays for the build and the other reuses it.
    points_suffix = f"{username}:v2:both:{time_class}:{min_user_rating}"
    habits_suffix = f"{username}:{min_user_rating}"
    points_base = f"improvement:losses:{points_suffix}"
    points_last = f"improvement:losseslast:{points_suffix}"
    habits_base = f"improvement:habits:{habits_suffix}"
    habits_last = f"training:habitslast:{habits_suffix}"

    engine = _async_engine_for(session)
    if engine is not None and engine.dialect.name == "postgresql":
        # Each build reads on its own pooled connection: the three are
        # independent, and together they were ~2s run one after another.
        factory = async_sessionmaker(engine, expire_on_commit=False)

        async def on_own_session(build: Callable[[AsyncSession], Awaitable[Any]]) -> Any:
            async with factory() as db:
                return await build(db)

        (opening_rows, latest_row), points_data, habits_data = await asyncio.gather(
            on_own_session(openings),
            _fresh_or_build(
                points_base, points_last, lambda: on_own_session(points_payload), _POINTS_FRESH_SECONDS,
            ),
            _fresh_or_build(
                habits_base, habits_last, lambda: on_own_session(habits_payload), _HABITS_FRESH_SECONDS,
            ),
        )
    else:
        # A session bound to one connection (SQLite in tests) keeps its reads sequential.
        opening_rows, latest_row = await openings(session)
        points_data = await _fresh_or_build(
            points_base, points_last, lambda: points_payload(session), _POINTS_FRESH_SECONDS,
        )
        habits_data = await _fresh_or_build(
            habits_base, habits_last, lambda: habits_payload(session), _HABITS_FRESH_SECONDS,
        )
    points = PointsLostOut.model_validate(points_data)

    phases_by_key = {p.phase: p for p in points.phases}
    kinds_by_key = {k.key: k for k in points.kinds}
    habits_by_key = {h["key"]: h for h in habits_data.get("habits", [])}

    recommendations: list[dict[str, Any]] = []

    def add_recommendation(
        *,
        playbook_id: str,
        priority_score: float,
        reason: str,
        evidence: str,
        metric_label: str,
        current_value: str,
        target_value: str,
        trend: str = "steady",
        concrete_fixes: list[dict[str, Any]] | None = None,
    ) -> None:
        playbook = PLAYBOOK_BY_ID.get(playbook_id)
        if not playbook:
            return
        recommendations.append(
            {
                "playbook_id": playbook.id,
                "priority_score": round(priority_score, 2),
                "reason": reason,
                "evidence": evidence,
                "metric_label": metric_label,
                "current_value": current_value,
                "target_value": target_value,
                "trend": trend,
                "concrete_fixes": concrete_fixes or [],
                "playbook": serialize_playbook(playbook),
            }
        )

    # 1. Core Skill Recommendations from Where-Points-Go + Habits
    quiet = kinds_by_key.get("quiet")
    middlegame = phases_by_key.get("middlegame")
    if quiet and quiet.share_of_loss >= 0.20:
        mg_note = (
            f" Middlegame accounts for {_format_pct(middlegame.share_of_loss)} of all lost winning chances."
            if middlegame
            else ""
        )
        add_recommendation(
            playbook_id="quiet_moves_planning",
            priority_score=100.0 + quiet.share_of_loss * 100.0,
            reason="Biggest positional leak: quiet moves without a clear plan or prophylaxis",
            evidence=(
                f"{_format_pct(quiet.share_of_loss)} of your total loss comes from quiet moves "
                f"({quiet.decisions:,} decisions).{mg_note}"
            ),
            metric_label="Quiet-move loss share",
            current_value=_format_pct(quiet.share_of_loss),
            target_value="Under 22%",
            trend="steady",
        )

    capturable = kinds_by_key.get("left_capturable")
    if capturable and capturable.share_of_loss >= 0.18:
        add_recommendation(
            playbook_id="blunder_prevention",
            priority_score=95.0 + capturable.share_of_loss * 100.0,
            reason="High one-move blunder cost: leaving pieces or tactics capturable",
            evidence=(
                f"{_format_pct(capturable.share_of_loss)} of your total loss comes from leaving "
                f"something the opponent could capture ({capturable.decisions:,} decisions)."
            ),
            metric_label="Left-capturable loss share",
            current_value=_format_pct(capturable.share_of_loss),
            target_value="Under 20%",
            trend="steady",
        )

    missed_punish = habits_by_key.get("missed_punishment")
    missed_forcing = kinds_by_key.get("missed_forcing")
    if (missed_punish and missed_punish.get("shows")) or (
        missed_forcing and missed_forcing.share_of_loss >= 0.10
    ):
        parts: list[str] = []
        trend = "steady"
        current_val = (
            _format_pct(missed_forcing.share_of_loss) if missed_forcing else "Elevated"
        )
        if missed_punish and missed_punish.get("shows"):
            rate = float(missed_punish.get("rate", 0.0))
            recent_rate = missed_punish.get("recent_rate")
            earlier_rate = missed_punish.get("earlier_rate")
            parts.append(
                f"You hand back {_format_pct(rate)} of opponent blunders "
                f"({missed_punish.get('handed_back', 0):,} of {missed_punish.get('events', 0):,})."
            )
            current_val = _format_pct(recent_rate if recent_rate is not None else rate)
            if recent_rate is not None and earlier_rate is not None:
                if recent_rate <= earlier_rate - 0.03:
                    trend = "improving"
                elif recent_rate >= earlier_rate + 0.03:
                    trend = "worsening"
        if missed_forcing and missed_forcing.share_of_loss > 0:
            parts.append(
                f"Missed captures or checks account for {_format_pct(missed_forcing.share_of_loss)} of loss."
            )
        add_recommendation(
            playbook_id="tactical_punishment",
            priority_score=82.0 + (missed_forcing.share_of_loss * 80.0 if missed_forcing else 12.0),
            reason="Opponent blunders are escaping unpunished",
            evidence=" ".join(parts),
            metric_label="Opponent blunders handed back",
            current_value=current_val,
            target_value="Under 25%",
            trend=trend,
        )

    second_mistake = habits_by_key.get("second_mistake")
    allowed_check = kinds_by_key.get("allowed_check")
    if (second_mistake and second_mistake.get("shows")) or (
        allowed_check and allowed_check.share_of_loss >= 0.08
    ):
        parts = []
        trend = "steady"
        current_val = (
            _format_pct(allowed_check.share_of_loss) if allowed_check else "Elevated"
        )
        if second_mistake and second_mistake.get("shows"):
            rate = float(second_mistake.get("rate", 0.0))
            base = float(second_mistake.get("baseline", 0.0))
            recent_rate = second_mistake.get("recent_rate")
            earlier_rate = second_mistake.get("earlier_rate")
            parts.append(
                f"Right after a mistake you blunder again {_format_pct(rate)} of the time "
                f"(baseline {_format_pct(base)})."
            )
            current_val = _format_pct(recent_rate if recent_rate is not None else rate)
            if recent_rate is not None and earlier_rate is not None:
                if recent_rate <= earlier_rate - 0.02:
                    trend = "improving"
                elif recent_rate >= earlier_rate + 0.02:
                    trend = "worsening"
        if allowed_check and allowed_check.share_of_loss > 0:
            parts.append(
                f"Allowing damaging checks is {_format_pct(allowed_check.share_of_loss)} of your total loss."
            )
        add_recommendation(
            playbook_id="defensive_resilience",
            priority_score=76.0 + (allowed_check.share_of_loss * 70.0 if allowed_check else 10.0),
            reason="One mistake often triggers a second error or king-safety collapse",
            evidence=" ".join(parts),
            metric_label="Second-mistake rate",
            current_value=current_val,
            target_value="Under 15%",
            trend=trend,
        )

    endgame = phases_by_key.get("endgame")
    if endgame and endgame.share_of_loss >= 0.14:
        add_recommendation(
            playbook_id="endgame_technique",
            priority_score=65.0 + endgame.share_of_loss * 80.0,
            reason="Endgame conversion is costing significant points",
            evidence=(
                f"Endgames account for {_format_pct(endgame.share_of_loss)} of your total loss "
                f"across {endgame.analyzed_decisions:,} decisions."
            ),
            metric_label="Endgame loss share",
            current_value=_format_pct(endgame.share_of_loss),
            target_value="Under 10%",
            trend="steady",
        )

    long_session = habits_by_key.get("long_session")
    if long_session and long_session.get("shows"):
        stop_after = int(long_session.get("stop_after", 4))
        drop = float(long_session.get("drop", 0.0))
        add_recommendation(
            playbook_id="session_discipline",
            priority_score=62.0 + drop * 150.0,
            reason=f"Late-session fatigue drops your score after game {stop_after}",
            evidence=(
                f"Games 1-{stop_after} score {long_session.get('early', 0) * 100:+.1f}% vs rating expectation, "
                f"while later games drop by {_format_pct(drop)} ({long_session.get('late_games', 0)} late games)."
            ),
            metric_label=f"Score drop after game {stop_after}",
            current_value=f"-{_format_pct(drop)}",
            target_value="Cap sessions at 3-4 games",
            trend="steady",
        )

    # 2. Opening Playbook Recommendations dynamically matched from actual games + opening_fixes
    bucket_stats: dict[str, dict[str, Any]] = {}
    for row in opening_rows:
        user_color = str(row["user_color"])
        eco = str(row["eco"])
        opening_name = str(row["opening_name"])
        playbook = _match_opening_playbook(user_color, eco, opening_name)
        if not playbook:
            continue
        entry = bucket_stats.setdefault(
            playbook.id,
            {"games": 0, "wins": 0, "draws": 0, "losses": 0, "samples": []},
        )
        games = int(row["games"] or 0)
        wins = int(row["wins"] or 0)
        draws = int(row["draws"] or 0)
        losses = int(row["losses"] or 0)
        entry["games"] += games
        entry["wins"] += wins
        entry["draws"] += draws
        entry["losses"] += losses
        if games >= 5:
            entry["samples"].append(
                {
                    "eco": eco,
                    "opening_name": opening_name,
                    "games": games,
                    "loss_rate": losses / games if games else 0.0,
                }
            )

    # Map concrete opening_fixes from where-points-go into matching opening playbooks
    fixes_by_playbook: dict[str, list[dict[str, Any]]] = {}
    for fix in points.opening_fixes:
        pb = _match_opening_playbook(fix.side_to_move, "", fix.opening_name or "")
        if not pb:
            continue
        fixes_by_playbook.setdefault(pb.id, []).append(
            {
                "fen": fix.fen,
                "last_move_uci": fix.last_move_uci,
                "opening_name": fix.opening_name,
                "played_san": fix.played_san,
                "best_san": fix.best_san,
                "occurrences": fix.occurrences,
                "average_loss_cp": fix.average_loss_cp,
            }
        )

    for pb_id, stats in bucket_stats.items():
        games = stats["games"]
        fixes = fixes_by_playbook.get(pb_id, [])
        if games < MIN_OPENING_GAMES and not fixes:
            continue
        score_rate = (stats["wins"] + 0.5 * stats["draws"]) / games if games else 0.0
        loss_rate = stats["losses"] / games if games else 0.0
        win_rate = stats["wins"] / games if games else 0.0
        # Recommend if the opening is leaking (loss_rate >= 45% or score_rate < 50%)
        # OR has a repeated concrete opening fix OR is a top-volume weapon (>= 60 games).
        is_leaking = loss_rate >= 0.45 or score_rate < 0.50
        is_high_volume = games >= 60
        if not (is_leaking or fixes or is_high_volume):
            continue

        # Weight by both severity (loss_rate above 40%) and volume (games) + concrete fixes.
        leak_weight = max(0.0, (loss_rate - 0.38) * 140.0)
        volume_weight = min(22.0, games * 0.25)
        fix_bonus = 18.0 if fixes else 0.0
        priority = 55.0 + leak_weight + volume_weight + fix_bonus

        if fixes:
            top_fix = fixes[0]
            reason = (
                f"Repeated opening blunder ({top_fix['played_san']} instead of {top_fix['best_san']} "
                f"{top_fix['occurrences']}x, avg -{top_fix['average_loss_cp']} cp)"
            )
        elif is_leaking:
            reason = f"High-loss opening leak over the last 12 months ({_format_pct(loss_rate)} loss rate)"
        else:
            reason = f"Core high-volume weapon ({games} games in the last 12 months): deepen middlegame plans"

        evidence = (
            f"Last 12 months: {games} games ({stats['wins']}W-{stats['draws']}D-{stats['losses']}L, "
            f"{_format_pct(win_rate)} win / {_format_pct(loss_rate)} loss)."
        )
        add_recommendation(
            playbook_id=pb_id,
            priority_score=priority,
            reason=reason,
            evidence=evidence,
            metric_label="12-month loss rate",
            current_value=_format_pct(loss_rate),
            target_value="Under 40%",
            trend="worsening" if loss_rate >= 0.52 else "steady",
            concrete_fixes=fixes,
        )

    # Include any concrete opening fix whose playbook had < MIN_OPENING_GAMES in the 12m window
    seen_ids = {rec["playbook_id"] for rec in recommendations}
    for pb_id, fixes in fixes_by_playbook.items():
        if pb_id in seen_ids or not fixes:
            continue
        top_fix = fixes[0]
        add_recommendation(
            playbook_id=pb_id,
            priority_score=74.0,
            reason=(
                f"Repeated opening mistake: {top_fix['played_san']} instead of "
                f"{top_fix['best_san']} ({top_fix['occurrences']}x)"
            ),
            evidence=(
                f"Average loss of {top_fix['average_loss_cp']} cp across {top_fix['occurrences']} games "
                f"in {top_fix['opening_name'] or 'this line'}."
            ),
            metric_label="Repeated blunder loss",
            current_value=f"-{top_fix['average_loss_cp']} cp ({top_fix['occurrences']}x)",
            target_value=f"Play {top_fix['best_san']}",
            trend="steady",
            concrete_fixes=fixes,
        )

    recommendations.sort(key=lambda item: item["priority_score"], reverse=True)

    biggest_phase = max(points.phases, key=lambda p: p.share_of_loss) if points.phases else None
    top_rec = recommendations[0] if recommendations else None

    return {
        "username": username,
        "time_class": time_class,
        "player_snapshot": {
            "latest_rating": int(latest_row["rating"]) if latest_row and latest_row["rating"] is not None else None,
            "analyzed_decisions": points.analyzed_decisions,
            "total_decisions": points.total_decisions,
            "biggest_phase": biggest_phase.phase if biggest_phase else None,
            "biggest_phase_share": round(biggest_phase.share_of_loss, 4) if biggest_phase else None,
            "top_focus": top_rec["playbook"]["title"] if top_rec else "Keep building your analyzed library",
        },
        "recommended": recommendations[:8],
        "catalog": [serialize_playbook(pb) for pb in PLAYBOOKS],
    }
