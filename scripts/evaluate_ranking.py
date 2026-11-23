from __future__ import annotations

import argparse
import asyncio
from sqlalchemy import text

from app.database import async_session_factory
from app.services.improvement import DEFAULT_TIME_CLASS
from app.services.ranking_eval import (
    DEFAULT_TOP_K,
    MIN_HOLDOUT_POSITIONS,
    MIN_TRAIN_POSITIONS,
    RollingRankingEvaluation,
    evaluate_ranking_rolling,
)


async def run(**kwargs: object) -> RollingRankingEvaluation:
    async with async_session_factory() as session:
        if session.bind.dialect.name == "postgresql":
            # Pages and rolling origins must see one evidence snapshot while
            # the background crawler continues committing new evaluations.
            await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        return await evaluate_ranking_rolling(session, **kwargs)  # type: ignore[arg-type]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Score the drill-queue ranking on time-ordered holdout games"
    )
    parser.add_argument("username")
    parser.add_argument("--color", default="both", choices=("white", "black", "both"))
    parser.add_argument(
        "--time-class", default=DEFAULT_TIME_CLASS, choices=("rapid_blitz", "rapid", "blitz")
    )
    parser.add_argument("--threshold-cp", type=int, default=80)
    parser.add_argument("--min-depth", type=int, default=18)
    parser.add_argument("--top-k", type=int, default=DEFAULT_TOP_K)
    args = parser.parse_args()

    result = asyncio.run(
        run(
            username=args.username,
            color=args.color,
            time_class=args.time_class,
            threshold_cp=args.threshold_cp,
            min_depth=args.min_depth,
            top_k=args.top_k,
        )
    )

    print(f"username  {result.username}\n")
    header = f"{'holdout':>8} {'cutoff':>12} {'train':>6} {'hold':>5} {'cover':>7} {'blind':>7} {'lift':>7}  patterns"
    print(header)
    print("-" * len(header))
    for split in result.splits:
        cutoff = f"{split.cutoff:%Y-%m-%d}" if split.cutoff else "—"
        # "Too small to score" on its own reads as a dead end. Say what is
        # missing, so the number can be watched as coverage grows instead of
        # being mistaken for a verdict about the ranking.
        note = ""
        if split.verdict == "insufficient":
            short = []
            if split.train_positions < MIN_TRAIN_POSITIONS:
                short.append(f"train {split.train_positions}/{MIN_TRAIN_POSITIONS}")
            if split.holdout_positions < MIN_HOLDOUT_POSITIONS:
                short.append(f"holdout {split.holdout_positions}/{MIN_HOLDOUT_POSITIONS}")
            note = f"  (needs {', '.join(short)})" if short else "  (no mistakes in one window)"
        print(
            f"{split.holdout_games:>8} {cutoff:>12} {split.train_positions:>6} "
            f"{split.holdout_positions:>5} {split.coverage:>6.1%} {split.baseline_coverage:>6.1%} "
            f"{split.lift:>+6.1%}  {', '.join(split.top_patterns) or '—'}{note}"
        )
    print(
        f"\nusable splits {result.usable_splits}"
        f"   mean lift {result.mean_lift:+.1%}"
        f"   worst {result.worst_lift:+.1%}"
    )
    print(f"verdict       {result.verdict}")
    if result.verdict == "insufficient":
        # A verdict of "insufficient" says nothing about whether the ranking
        # works; it says the library has not been analysed enough to ask yet.
        # The lift column is still the measurement, so report what it shows.
        scored = [s for s in result.splits if s.train_positions and s.holdout_positions]
        if scored:
            lifts = [s.lift for s in scored]
            print(
                f"              not a verdict on the ranking - the library is not analysed\n"
                f"              enough to score it. Across {len(scored)} split(s) with any evidence,\n"
                f"              lift so far ranges {min(lifts):+.1%} to {max(lifts):+.1%}."
            )
        else:
            print("              no split has evidence on both sides of its cutoff yet.")


if __name__ == "__main__":
    main()
