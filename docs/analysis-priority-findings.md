# What is worth searching first

Measured 2026-09-13 against the live library (`saint_uwe`, 7,525 rapid/blitz
games, 270,741 of the player's own decisions). Every number here came from
searching real positions with the same Stockfish 19 build the browser loads
(`scripts/engine/`), not from a different engine and not from assumption.

Raw results: `docs/triage-experiment-2026-09-13.json`. Reproduce with
`make triage-measure SAMPLE=...`, then `python3 scripts/engine/report_triage.py`.

## Count distinct decisions, not instances

The single most misleading number here is "analyzed decisions". The coverage
query counts decision *instances* — one per game in which the decision occurred
— so a library reporting 4,077 analyzed decisions had **177 distinct** ones
behind it, and the drill pipeline, which groups by position, found 23 candidate
mistakes. Any claim about how much a change improves coverage has to be measured
in distinct decisions, or it measures repetition.

## The problem

At the time of measurement 3.9% of the player's decisions could be graded. A
decision needs both of its positions searched to a shared depth, so covering the
library means roughly 393,000 searches. The order they happen in decides what
the player can be taught this month rather than next year.

## Openings repeat; nothing after them does

| | distinct positions | decisions | mean per position | max |
|---|---|---|---|---|
| opening (ply ≤ 20) | 44,591 | 74,193 | 1.66 | **2,968** |
| after ply 20 | 195,372 | 196,548 | 1.01 | 3 |

7,521 opening positions carry 91% of all opening decisions. Past the opening
there is no leverage at all: essentially every decision needs its own two
searches.

### Ordering the opening queue by recurrence was tried, and reverted

The obvious move is to search the most-repeated opening positions first, and
measured by decision *instances* it works: one 24-position batch went from
unlocking +28 to +217. That number is misleading, and acting on it was a
mistake.

A decision instance is not a lesson. The drill pipeline groups candidates by
position, so fifty repetitions of one opening position produce one lesson.
Measured in **distinct** decisions, the same batches unlocked **+10 either
way** — recurrence ordering bought nothing at all.

It also steered coverage into the worst place to look. The positions a player
repeats most are their own main lines, which they know. Measured over the corpus
recurrence ordering built:

| | distinct gradeable decisions | mistakes ≥100cp | rate |
|---|---|---|---|
| opening (recurrence-ordered) | 64 | 3 | **4.7%** |
| after the opening | 100 | 21 | **21.0%** |

So it cost a 1.7s query and half the mistake-discovery rate to unlock the same
number of lessons. The opening bucket is back to recency. Finding a better
opening signal — deviation from master theory is the obvious candidate, and the
data for it is already stored — is open work, and should be measured the same
way before it is believed.

## After the opening, the clock is the signal — and it points the other way

210 decisions (70 per phase, sampled by hash so the choice is not ours),
searched at depth 22:

| think time | n | mistake ≥100cp | blunder ≥200cp |
|---|---|---|---|
| 0–1s | 25 | **8.0%** | 4.0% |
| 1–2s | 42 | 26.2% | 19.0% |
| 2–4s | 59 | 30.5% | 18.6% |
| 4–8s | 48 | 22.9% | 16.7% |
| 8–15s | 19 | 31.6% | 10.5% |
| ≥15s | 17 | **52.9%** | **41.2%** |

This contradicts the usual assumption that rushed moves are the blunders. A move
played in under a second is almost always a recapture or a forced reply; a long
think marks a position the player found genuinely hard, and that is where they
go wrong. Ordering the middlegame and endgame buckets by think time descending
raised the median think time of queued post-opening decisions from 4.5s to
23.8s — from the ~25% band into the ~53% band.

The tail buckets are small (17 and 25), so this orders work rather than
discarding any: every decision is still crawled, the informative ones first.

Mistake rate by phase, same sample: middlegame 34.3%, opening 27.1%,
endgame 20.0%.

## A shallow pass could triage, at a known cost — not currently used

Depth 12 costs **94x** less than depth 22 (23s against 2,159s for the same 420
positions). Using a depth-12 search only as a gate, and paying depth 22 only
where it fires:

| shallow gate | sent to depth 22 | mistakes ≥100cp caught | engine time |
|---|---|---|---|
| 30cp | 44.8% | 89.5% | −54% |
| 50cp | 37.1% | 87.7% | −62% |
| 75cp | 29.5% | 84.2% | −69% |
| 100cp | 25.7% | 75.4% | −73% |
| 150cp | 17.1% | 50.9% | −82% |

So a cascade is real but lossy: roughly an eighth of genuine mistakes never get
looked at properly. Depth 12 is also a visibly different reading — median 18cp
away from depth 22, agreeing on the best move only 70% of the time — so its
numbers may gate a decision but must never be mixed with a depth-22 one when
grading it (the multi-depth schema already forbids that).

**Not implemented.** Throughput stopped being the binding constraint once
background crawling was allowed, and this trades accuracy for speed. The
measurement is recorded here so the trade can be made deliberately if throughput
becomes scarce again.

## Throughput: more engines, not more threads

Coverage's unit is the distinct decision, and a decision needs both of its
positions searched, so the ceiling is about **0.5 distinct decisions per
search** no matter how work is ordered. Ordering decides *which* decisions get
covered; only throughput decides how many.

Positions are independent of each other, while Stockfish's parallel search
shares one tree. Measured over eight library positions at depth 22, each
configuration in a fresh process after a warm-up, in positions/min:

| engines x threads | 1x1 | 2x1 | 3x1 | 4x1 |
|---|---|---|---|---|
| | 16.7 | 30.5 | **49.5** | 47.7 |

| threads on one engine | 1 | 2 | 4 |
|---|---|---|---|
| | 16.7 | 21.8 | 12.8 |

Three engines is the knee on this box; a fourth buys nothing, and four threads
inside one engine is *worse than two*. The crawler therefore runs a pool of
single-threaded engines sharing one work queue.

One trap: the load-average guard counts the crawler's own engines, so a larger
pool reads as a busier machine and stands itself down. The guard subtracts the
pool's own contribution before judging, which is what "yield to other work"
was always supposed to mean.

## Cover every era, or the library can never be validated

The queue walked games newest-first and stopped once it had enough candidates,
which meant it never reached old games at all. Measured after a crawl session:

| month | distinct covered decisions |
|---|---|
| current | **379** |
| each earlier month | 19–42 |

The cost is not just that old games go unstudied. Every temporal claim the
platform makes — "this ranking predicts your future mistakes", "this pattern is
getting worse" — is measured by comparing an older window against a recent one.
With the older window empty, `make ranking-eval` returns `insufficient` forever
no matter how much is crawled.

The walk now rotates through four eras of the player's history, newest first,
the last taking whatever the others leave unspent. Recent play is still covered
first; it just cannot take everything.

## The ranking is measurable, and it beats chance

With coverage spread across eras, `make ranking-eval saint_uwe` scored for the
first time. Four usable time-ordered splits, each training the pattern ranking
on games before a cutoff and testing which patterns actually cost the player
evaluation in the games after it:

| holdout games | cutoff | train | holdout | covered loss | blind baseline | lift |
|---|---|---|---|---|---|---|
| 682 | 2026-04-08 | 169 | 155 | 40.6% | 19.7% | **+20.9%** |
| 568 | 2026-05-01 | 171 | 155 | 41.2% | 19.7% | **+21.4%** |
| 455 | 2026-05-26 | 171 | 155 | 41.2% | 19.7% | **+21.4%** |
| 341 | 2026-06-19 | 172 | 155 | 41.3% | 19.7% | **+21.6%** |

**Verdict: better than chance.** Mean lift +21.3%, worst split +20.9%. The top
three patterns it selects — missed mate, advantage conversion, skewer — account
for about 41% of the evaluation the player goes on to lose, against about 20%
for picking the same number of patterns blindly.

Three older splits still read `needs train 104/150` and are excluded; their lift
was volatile at lower coverage (-2.1% to +15.7% as evidence accumulated), which
is the reason the threshold exists.

## Checking the verdict: how much of it is the ranking?

"Better than chance" is a low bar, so the top-3 the ranker picks was compared
against what else could have been picked from the same training-time options,
on the 2026-06-19 split (169 train / 149 holdout positions, 14 distinct training
patterns, 99.4% of holdout loss falling in patterns seen in training):

| selection rule | share of future loss captured |
|---|---|
| worst 3 of the same options | 6.7% |
| random 3 (the reported baseline) | 21.3% |
| **the drill ranking** | **40.8%** |
| sort by total training loss | 44.0% |
| perfect hindsight (best 3 judged on the holdout) | 44.5% |

So the ranking reaches 92% of what was achievable, and the verdict is not an
artifact of a soft comparator. But a one-line "sort by total training loss"
beats it by **3.2 points**, on every one of the four scoring splits, and lands
within half a point of hindsight.

That gap is a deliberate design choice showing up, not a defect.
`pattern_priority_score` is `(loss / occurrences) * sqrt(positions)` — severity
per instance, with breadth as support — so it ranks:

| pattern | total loss | occurrences | positions | avg | later share |
|---|---|---|---|---|---|
| missed_mate | 4,201 | **3** | 3 | **1,400** | 7.4% |
| advantage_conversion | 10,734 | 43 | 43 | 250 | 23.0% |
| skewer | 6,953 | 19 | 19 | 366 | 10.3% |
| fork | 6,213 | 21 | 20 | 296 | **10.7%** |

The ranking takes `missed_mate` over `fork`: three occurrences averaging a whole
game each, against twenty-one averaging a third of a pawn. The evaluation only
counts total loss, so it scores that swap as a 3.3-point loss. Which is right is
a coaching judgement — fix what costs you a game when it happens, or what costs
you the most points overall — and not something this measurement settles. Worth
noting that `missed_mate` clears the `_HABIT_MIN_POSITIONS` gate with exactly
three positions, so it is the thinnest evidence in the table.

## Era rotation without the latency

Rotating four eras meant four walks, and on the old fixed 250-game page that
took `/api/games/unanalyzed-fens` from about 60ms to 140ms warm. Profiling put
79% of the time in the pair query, and its plan explained why: it joined **10,943
candidate rows and sorted them all to keep 96**. Cost tracks page size almost
exactly:

| games per page | 250 | 100 | 50 | 25 |
|---|---|---|---|---|
| pair query | 55.7ms | 26.5ms | 12.7ms | 7.6ms |

A fixed small page is wrong too: once most positions are analysed each game
yields little work and the walk would page over and over. So the page starts at
32 games and doubles only when a full page still fails to fill its target. The
endpoint is back to **~70ms** warm, with all four eras still covered.

## The endgame bucket was starved by how candidates were sourced

Found while verifying the latency fix, and not caused by it — the skew was
identical at any page size. Work remaining by phase, at review depth:

| phase | decisions still needing work |
|---|---|
| middlegame | 91,010 |
| opening | 32,239 |
| endgame | **26,663** |

Endgames were 17% of the outstanding work and a 24-position batch surfaced
**one**. The cause was the candidate pool, not the phase rotation: the per-era
pair query took the first ~96 rows ordered by `played_at DESC, ply ASC`, which
is the opening and early middlegame of the newest game or two in that era. The
rotation can only rotate between phases that have candidates.

Fetching each page from both ends of its games was tried first. It helped the
opening bucket and not the endgame — "endgame" is decided by material, not by
being late in the game, and many games end with pieces still on — and it cost
50% of the latency fix, so it was dropped.

The fix computes the phase **in the query** (`_board_phase`, mirroring
`_COVERAGE_SQL`'s material count, with the same dialect split for the board
placement) and gives each phase its own share of the page via
`ROW_NUMBER() OVER (PARTITION BY phase ...)`. The pool is then balanced by
construction rather than by which game the page landed on.

| | before | after |
|---|---|---|
| phases in a 12-pair batch | 1 endgame / 8 middlegame / 3 opening | **4 / 4 / 4** |

The window function is not what costs: measured directly against the same query
without it, ranking per phase came out *cheaper* (11.3ms against 15.4ms). The
real variable is how many pages the walk needs, which is why the page size was
swept again with repeats — 32 games is the knee (~120ms in-handler; 16 needs six
queries, 64 and 96 read too much):

| games per page | 16 | 32 | 64 | 96 |
|---|---|---|---|---|
| handler total | 152–213ms | **117–124ms** | 161–176ms | 234–266ms |

End to end the endpoint sits at **~88ms** warm, against 140ms before any of this
and 75ms with the latency fix alone — so correct phase balance cost about 13ms.
