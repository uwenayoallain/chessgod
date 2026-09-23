"""Report what the triage experiment measured.

Two questions, answered from one set of searches over real decisions:

1. Does a shallow search predict what a deep one would have said? If it does,
   the crawl can search cheaply everywhere and pay review depth only where the
   cheap pass saw something, which is the only way a library this size gets
   covered at all.
2. Does the clock predict a mistake? Past the opening, positions do not repeat,
   so the crawl can never cover that part of the game — it can only sample it.
   A signal that costs no engine time is the only way to sample it well.
"""

from __future__ import annotations

import json
import sys
from statistics import median

BLUNDER_CP = 200
MISTAKE_CP = 100


def classify(loss: float | None, threshold: int) -> bool:
    return loss is not None and loss >= threshold


def report(path: str, clocks: dict) -> None:
    data = json.loads(open(path).read())
    rows = [r for r in data["rows"]
            if r["shallow_cp_loss"] is not None and r["deep_cp_loss"] is not None]
    shallow_s, deep_s = data["shallow_seconds"], data["deep_seconds"]
    print(f"{len(rows)} decisions measured at depth {data['shallow_depth']} and {data['deep_depth']}")
    print(f"engine time: shallow {shallow_s}s, deep {deep_s}s  ({deep_s / max(shallow_s, 1):.0f}x)\n")

    for threshold, label in ((MISTAKE_CP, "mistake >=100cp"), (BLUNDER_CP, "blunder >=200cp")):
        truth = [r for r in rows if classify(r["deep_cp_loss"], threshold)]
        print(f"--- {label}: {len(truth)} of {len(rows)} decisions ({100*len(truth)/len(rows):.1f}%)")
        # A triage gate must not miss real errors. Sweep the shallow cutoff and
        # report what each one would have cost and caught.
        for gate in (30, 50, 75, 100, 150):
            flagged = [r for r in rows if classify(r["shallow_cp_loss"], gate)]
            caught = [r for r in flagged if classify(r["deep_cp_loss"], threshold)]
            recall = 100 * len(caught) / len(truth) if truth else float("nan")
            deep_share = 100 * len(flagged) / len(rows)
            # Cheap pass everywhere + deep pass only on what it flagged.
            cost = shallow_s + deep_s * len(flagged) / len(rows)
            saving = 100 * (1 - cost / deep_s)
            print(f"   shallow gate {gate:>3}cp: flags {deep_share:5.1f}% for deep search, "
                  f"catches {recall:5.1f}% of them, engine time -{saving:4.1f}%")
        print()

    diffs = [abs(r["deep_cp_loss"] - r["shallow_cp_loss"]) for r in rows]
    agree = sum(1 for r in rows if r["shallow_best"] == r["deep_best"])
    print(f"shallow vs deep cp_loss: median diff {median(diffs):.0f}cp, "
          f"best move agrees on {100*agree/len(rows):.0f}%\n")

    # --- the clock question -------------------------------------------------
    timed = [(r, clocks.get(f"{r['parent_fen']}|{r['child_fen']}"))
             for r in rows]
    timed = [(r, c) for r, c in timed if c and c.get("think_seconds") is not None]
    if not timed:
        print("no clock data joined to these decisions")
        return
    print(f"--- clock signal on {len(timed)} decisions with clock data")
    think_median = median(c["think_seconds"] for _, c in timed)
    for name, predicate in (
        (f"played fast (<= {think_median:.1f}s, the median)",
         lambda c: c["think_seconds"] <= think_median),
        ("played very fast (<= 2s)", lambda c: c["think_seconds"] <= 2),
        ("low clock (<= 60s left)",
         lambda c: c.get("clock_seconds_after") is not None and c["clock_seconds_after"] <= 60),
        ("long think (>= 15s)", lambda c: c["think_seconds"] >= 15),
    ):
        group = [r for r, c in timed if predicate(c)]
        rest = [r for r, c in timed if not predicate(c)]
        if not group or not rest:
            print(f"   {name}: not enough data")
            continue
        rate = 100 * sum(1 for r in group if classify(r["deep_cp_loss"], MISTAKE_CP)) / len(group)
        base = 100 * sum(1 for r in rest if classify(r["deep_cp_loss"], MISTAKE_CP)) / len(rest)
        print(f"   {name:<40} n={len(group):>3}  mistake rate {rate:5.1f}%  vs {base:5.1f}% otherwise"
              f"  ({rate/base if base else float('inf'):.2f}x)")


if __name__ == "__main__":
    clock_path = sys.argv[2] if len(sys.argv) > 2 else None
    clocks = json.loads(open(clock_path).read()) if clock_path else {}
    report(sys.argv[1], clocks)
