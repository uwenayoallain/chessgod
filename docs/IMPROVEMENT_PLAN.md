# ChessGod improvement plan

## Absolute product goal

ChessGod exists to make a player measurably better at rapid and blitz. Importing games,
exploring openings, and running an engine only matter when they feed this loop:

1. Find the decisions that cost the most and the patterns that repeat.
2. Put the player back into those exact positions without showing the answer.
3. Check the move on the board and explain a concrete thinking correction.
4. Schedule the position again until the correction sticks.
5. Measure whether the pattern becomes rarer in new games.

Every username uses the same pipeline. `saint_uwe` is the first real corpus, not a
hard-coded special case.

## Evidence from the first corpus

Public Chess.com stats checked on 2026-09-03 show:

| Scope | Current rating | Rated record | Rated games |
| --- | ---: | --- | ---: |
| Rapid | 1590 | 1215 W / 194 D / 1048 L | 2457 |
| Blitz | 1422 | 870 W / 79 D / 734 L | 1683 |
| Bullet | 1121 | 1618 W / 113 D / 1547 L | 3278 |

Sources: [profile](https://www.chess.com/member/saint_uwe),
[public stats API](https://api.chess.com/pub/player/saint_uwe/stats), and
[archive list](https://api.chess.com/pub/player/saint_uwe/games/archives).

After the cached archive refresh on 2026-09-07, the local corpus contains 2,470 rapid and
1,740 blitz games: 4,210 focus games in total. It also contains 3,281 bullet games and 27
daily games. Archive counts—not rating totals—are the import and coverage source of truth.
Bullet remains available for exploration but is excluded from the learning queue and
default workspace scope because its error distribution rewards a different skill.

The archive also exposes a concrete clock pattern: 200 of 766 blitz losses ended on time
(26.1%), compared with 35 of 1,050 rapid losses (3.3%). The generic improvement summary
therefore reports time-loss rates by time class when the sample is large enough; it does
not hard-code this Saint_Uwe result.

## Learning model

### What becomes a drill

A position is eligible when both the position before the player's move and the position
after it have a rank-one evaluation at the minimum trusted depth. A forced mate is stored
as a mate distance rather than a centipawn score, so mate scores are folded into a clamped
centipawn band instead of being discarded; without that, every missed and allowed mate is
invisible to the queue. Centipawn loss is calculated from the player's color, never from
White's perspective alone. The first release uses an 80 cp threshold and retains one
representative game for context.

Candidates are ranked by:

- centipawn loss, capped so one spectacular blunder cannot dominate forever;
- recurrence of the same decision;
- low or missing drill accuracy;
- whether the spaced-review date is due.

The queue returns at most 20 positions and scans at most 1,000 grouped candidates. The UI
does not download games or PGNs to build the queue.

A session is then composed from that ranking rather than sliced off the top of it. It
rotates through four reasons to train a position — a spaced-repetition review that is due,
a transfer position, an error from the most recent games, and a pattern whose trend is
getting worse — and whichever pool runs dry falls back to the global ranking, so the set is
always full. A transfer position is the same failure mode and phase in a near-identical
material shape from a *different* game of the player's own; it is drawn immediately after
the first card so the same idea is practised twice in a row. Nothing outside the player's
own games ever enters the set, and each card reports which of those reasons put it there. Length
is budgeted in time, not cards: a single-move drill is costed at 40 seconds and a two-move
calculation drill at 60, and the set stops at a ten-minute budget or the card limit,
whichever comes first.

Where the stored best line runs at least three plies and the first move does not end the
game, the drill plays the opponent's best reply and asks for the second move as well. Both
moves must match for the review to count as solved; a client that submits only the first
move is scored on that move alone.

### Pattern taxonomy

Labels must come from verifiable position facts and remain useful across openings and
users:

- hanging material: the opponent's best reply captures a piece;
- king safety: the opponent's best reply is a forcing check;
- missed capture: the engine's best move starts with a capture;
- missed forcing move: the engine's best move is a check;
- converting an advantage: the player was already at least +1.5 in their perspective;
- defensive resource: the player was at least -1.5 and missed the best resistance;
- opening decision: an early non-forcing error;
- endgame technique: a low-material error;
- calculation: the remaining middlegame decisions.

Where the stored principal variation supports it, a more specific label replaces the coarse
one. These are read from board geometry replayed move by move, never from an evaluation
number: a missed or allowed forced mate, a fork (one piece attacking two qualifying
targets), a pin or a skewer (two enemy pieces back to back on an empty ray, ordered by
value), a back-rank threat (a rook or queen checking along the king's own back rank with
every escape square blocked by its own pieces), and removing the defender (a capture of the
only guard, where the same line then wins the piece it guarded). Each motif carries the
concrete fact that proves it and whether the player allowed it or missed it, and the card
shows those facts only after the answer.

One-off severe errors and repeated cross-position habits are separated rather than merged.
A failure mode seen in at least three different positions is a habit; the same position
played wrong more than once is a repeat; anything else is a one-off. A one-off keeps its
place in the queue but its severity is damped, so a single spectacular blunder cannot lead
every session or become the weekly focus.

The explanation names the played move, best move, and evaluation loss. The cue is a
repeatable over-the-board action, such as checking every opponent capture before moving.
Future labels must pass the same evidence rule; they cannot be generated from an opaque
guess.

### Measuring whether it works

Four numbers are reported next to each other rather than one score: recurrence per pattern
(habit, repeat, or one-off), average and worst centipawn loss per pattern, drill retention
(how many corrections have been answered correctly at least twice in a row, and how many
have lapsed back to a zero streak), and the win/draw/loss record per time class.

A trend direction is refused unless the evidence supports it. Both 30-game windows must be
full, at least 30 analyzed decisions must exist in each, the pattern needs at least six
occurrences in total, and the window carrying the claim needs at least three of its own: a
pattern falling from two occurrences to zero is reported as insufficient, never as an
improvement.

### Stating the thinking, not just the move

Before the answer is shown, the player can name the routine they were running — the
opponent's captures, threats to their king, their own forcing moves, converting, the clock,
or one concrete line. Each routine is mapped to the failure modes it actually catches, and
the feedback compares the claim with the detected pattern: a match means the routine ran
too shallow, a mismatch means that check was missing here. The claim is stored on the
attempt, so which routines the player believes they run stays measurable over time. Stating
nothing produces no judgement.

### Review scheduling

Wrong answers return after ten minutes and reset the streak. Correct answers return after
1 day, 3 days, then an ease-adjusted interval capped at 60 days. Aggregate progress is
stored separately from append-only attempts so queue reads stay small while longitudinal
measurement remains possible.

## Module shape

The improvement module has one read interface and one write interface:

- `GET /api/improvement/plan` returns coverage, pattern totals, and the ranked drill queue.
- `POST /api/improvement/attempts` validates the expected move against current stored
  analysis, scores the played move, appends evidence, and updates the next review date.

The interface hides engine-provider differences, SQL grouping, pattern rules, scoring,
and scheduling. The React trainer only renders a card, loads its FEN, observes the move
made on the shared board, and submits the attempt.

## Delivery phases

### Phase 1 — usable correction loop

- [x] Rapid + Blitz combined scope supported end to end and selected by default.
- [x] All analyzed errors can enter the queue; exact-position recurrence and master-book
  deviation are no longer prerequisites.
- [x] Deterministic pattern classification and plain-language thinking cues.
- [x] Real-board drills from past positions with answer checking and source-game context.
- [x] Persistent attempts, accuracy, streak, due date, and spaced repetition.
- [x] Generic clock-management and repeated weak-opening signals from outcome data.
- [x] Cached, bounded candidate query and indexed progress tables.
- [x] Apply migration `011` and verify the API against the production-size Saint_Uwe
  database (7,502 games after the 2026-09-03 refresh).
- [x] Verify rebuilt runtime-only Docker images end to end, including migration startup,
  configurable host ports, frontend/API wiring, CORS, and live Saint_Uwe plan responses.
- [x] Run a rendered desktop/mobile interaction review.

### Phase 2 — better diagnosis

- [x] Parse `%clk` comments during import, backfill stored PGNs without network requests, and
  add evidence-backed time-pressure patterns.
- [x] Use the stored principal variation to distinguish forks, pins, skewers, removal of
  defenders, back-rank threats, and missed mate without making unsupported claims.
- [x] Compare pattern frequency per 100 games across rolling 30-game windows.
- [x] Separate one-off severe errors from repeated cross-position habits.
- [x] Show confidence and analyzed-decision sample size beside every trend.
- [x] Analyze complete before/after decision pairs in phase-balanced browser batches so
  opening positions cannot consume the frontier ahead of available later-game positions.

### Phase 3 — adaptive training

- [x] Accept multiple same-depth engine moves when they are within a 30 cp evaluation band,
  instead of requiring a single exact UCI move.
- [x] Continue the opponent's best reply and require a second move for calculation drills.
- [x] Mix due positions, recent-game errors, and weak patterns into a fixed 10-minute set.
- [x] Add “transfer” drills: structurally similar positions from other games, never puzzles
  unrelated to the player's evidence.
- [x] Let players state their intended thought process, then compare it with the detected
  failure pattern.

### Phase 4 — prove improvement

- [x] Track recurrence per pattern, average centipawn loss, drill retention, and result by
  time class.
- [x] Declare a pattern improving only when its newer window is better with enough samples.
- [x] Show one weekly prescription: what to train, what to stop studying, and why.
- [x] Evaluate queue-ranking changes on time-ordered holdout games, not the same games used
  to create drills.

## What the evidence base actually is (2026-09-06)

Coverage was being reported as evaluated positions over every distinct position in
every game — 2.2% on the first corpus. That denominator answers a question nobody
asked: most of those positions are the opponent's moves, or positions the player never
had to choose in. The metric is now the player's own decisions, and a decision counts
as analyzed only when the position before the move and the position after it both
carry a trusted evaluation, which is exactly what a drill needs. On the same corpus
that reads 18,336 of 160,298 decisions (11.4%), yielding 531 grouped mistake
candidates. The bounded scan now covers every current candidate while retaining headroom
for larger corpora; the API still marks the count as a lower bound if it reaches 1,000.

The bottleneck is *where* the evidence sits. 99.0% of analyzed decisions are in the
opening, 0.6% in the middlegame and 0.4% in the endgame, against a mean game length of
48-89 plies. The drill queue's own frontier is healthy (median queued ply 41, half past
ply 41), but the browser analysis scheduler was not: it walked the earliest plies of the
newest games first, reinforcing the opening-heavy sample. It now selects the position
before and after a player decision as one unit and round-robins endgame, middlegame, then
opening pairs while preserving recency within each phase. The even 24-position batch means
a wholly missing pair is never split merely to fill the queue. The UI reports analyzed,
candidate, depth, percentage coverage, and the selected decision-pair count by phase even
while the worker is off. Completed recent pairs are excluded before the bounded query is
filled, so the frontier advances into older games instead of reverting to isolated FENs.

Lichess cloud evals can only ever return opening positions, because a club player's
middlegame has rarely been cached, and the browser autopilot is the only other source since
there is deliberately no server engine. It previously defaulted to off and lost its opt-in
on every reload. The opt-in is now remembered; it still starts off, because nothing should
peg a CPU without being asked.

Until that skew evens out, the weekly prescription says so rather than presenting an
opening-only sample as the player's whole game.

## Evaluating a ranking change

`make ranking-eval USERNAME=name` splits a player's games by date, builds the ranking from
the older games only, and scores it on the newest quarter it never saw. The question is how
much of the evaluation loss the player actually went on to give away in those unseen games
belongs to the patterns the ranking chose to train, measured against what picking the same
number of patterns blind would have been worth. Both windows run through the same candidate
query and the same classifier as the live queue, so the harness scores the real ranking
rather than a copy of it, and it reports “insufficient” rather than a verdict when the
holdout is too small to mean anything.

## Rendered interaction review

The Review workspace was driven end to end in a real browser against the live Saint_Uwe
database at 1440×900 and 390×844, from opening the tab through starting a set, stating an
intent, and solving a card. Three defects were found and fixed:

- The board drew the engine's best-move arrow and the opponent's hanging-piece threat arrow
  while a drill was waiting for an answer, which handed the player the tactic the drill was
  asking about. Board arrows and move annotations are now suppressed for as long as a card
  is open, and released once the answer is shown.
- On a phone the whole board was clipped away: stacked at that width, every wrapper between
  the workspace and the board took its height from a zero-basis flex column, so the board
  resolved to two pixels inside an `overflow: hidden` container. The stacked layout now
  sizes the board from an intrinsic square and lets the wrappers take their height from it.
- The header action row was 24 px wider than a 390 px viewport and clipped the theme
  selector off the right edge. It now wraps.

After the fixes the page has no horizontal overflow at 390 px, no element crosses the
viewport edge, and no guidance arrow is drawn while a card is unanswered.

### Result of the ranking evaluation

The first ranking failed: across four time-ordered origins its top-three patterns covered
21.9%, 19.7%, 15.7%, and 11.7% of holdout evaluation loss against a 23.1% blind baseline.
Its mean lift was −5.8% and it never won, because summing lifetime loss allowed the biggest,
lowest-specificity bucket to dominate forever.

The shipped priority is now average observed loss per occurrence multiplied by the square
root of distinct mistake positions. That is a deliberate risk/evidence compromise: raw
frequency no longer buries severe recurring failures, one spectacular blunder cannot win
on severity alone, and repeated visits to one exact position are not mistaken for
independent evidence that the habit will transfer. The live prescription and offline
evaluator call the same scoring function.

On the same four future windows, with the live one-off guard included, that score covered
31.6%, 29.9%, 27.3%, and 24.0% of evaluation loss: lifts of +8.5%, +6.8%, +4.2%, and +0.9%
over the 23.1% blind baseline. Mean lift is +5.1%, the worst origin remains positive, and
the conservative harness therefore reports “better than chance.” Three additional cutoffs
held aside during selection produced +10.2%, +12.6%, and +11.7% lift. All seven are now in
the default evaluation. Rapid/Blitz and White/Black slices, plus the two other imported
corpora, do not separately meet the minimum 150 train and 150 holdout mistake positions;
they are reported as insufficient instead of being used to make a generalization claim.

The harness is deliberately conservative: a split is refused unless it has at least
150 train and 150 holdout candidates (splits with 36-70 swung from +41% to −36% for an
unchanged ranking), and `make ranking-eval` now reports seven rolling origins with mean
and worst lift, only calling a ranking better than chance when it beats the baseline on
average *and* never loses to it on any origin.

## Performance gates

- Warm `GET /api/improvement/plan`: p95 under 150 ms.
- Cold plan query on the production-size corpus: p95 under 2 seconds.
- Attempt write: p95 under 100 ms excluding network latency.
- Initial trainer JavaScript: no additional engine or PGN payload.
- Candidate scan bounded at 1,000; queue bounded at 20.
- All progress lookups use `(username, due_at)` or the unique
  `(username, position_id, expected_move_uci)` index.
- Browser Stockfish remains opt-in/background and server-side native Stockfish remains
  prohibited.

Re-measured against the live Saint_Uwe database on 2026-09-07, after motif detection,
two-move drills, and session composition were added: the plan endpoint returned in 1.19 s
fully cold and 48 ms warm (p95 over ten reads), inside both gates. Classification and
principal-variation replay are computed once per candidate-cache fill rather than per
request; doing that work per request had pushed warm reads to 510 ms. Migration `013`
applied cleanly to the existing PostgreSQL volume. After the risk/evidence ranking change,
the holdout harness scored the current top-three pattern selection at 24.0–35.7% of future
evaluation loss against a 23.1% blind baseline over seven rolling origins. Every lift was
positive (+0.9% to +12.6%), with a +7.8% mean. A rebuilt live read on 2026-09-07 returned
in 48–71 ms across ten warm reads. Ten cache-cleared reads initially missed the cold gate
at 2.44 seconds p95 because coverage disabled PostgreSQL's indexed nested-loop plan and ran
serially after candidate extraction. Removing that planner override and overlapping the two
independent read-only queries brought cold mean to 1.41 seconds and p95/max to 1.67 seconds,
without reducing evaluation depth, candidate count, or corpus scope. After expanding the
candidate bound from 500 to 1,000, all 531 current grouped mistakes are included rather
than reporting a `500+` lower bound. Ten fully cache-cleared reads remained faster than the
gate: 1.01-1.17 seconds, 1.10 seconds mean and 1.17 seconds p95/max; warm reads were
51-55 ms. The seven-origin ranking result remained unchanged at +7.8% mean lift and +0.9%
worst lift.

Imports, browser evaluations, and Lichess cloud evaluations now share one cache-invalidation
contract. It clears the versioned plan, trend, context, and coverage keys only for usernames
whose games changed or contain the evaluated positions. This prevents stale coaching after
new evidence without flushing every other user's warm plan on each browser engine batch.

On the refreshed Saint_Uwe corpus, the current bounded plan returns 10 mixed drills filling
a 600-second session from all 531 ranked candidates, with clock context, two 30-game trend
windows, and a weekly prescription. The database contains
287,879 distinct rapid/blitz positions, with 6,344 evaluated at trusted depth (2.20%
coverage), plus 320,517 move-clock records across 4,210 focus games. The
final depth-22 frontier query avoids sorting all 160,298 player decisions. It returned 24
phase-balanced targets in 1.51 seconds fully cold and 0.05-0.10 seconds warm, split evenly
across 4 endgame, 4 middlegame, and 4 opening decisions in the latest live response.
At depth 22, 3,989 of 287,879 distinct positions currently meet the requirement. Migrations
`011` and `012` applied cleanly to the existing PostgreSQL volume. The latest source
production build emitted 346.48 kB of application JavaScript (101.62 kB gzip), with chess
and query libraries split into separate chunks. A cached image rebuild completed in 12 seconds;
the backend image is 76.8 MB and contains runtime dependencies only.

## Completion criteria

The rebuild is complete only when a new username can import games, land by default in a
rapid/blitz scope, receive evidence-backed pattern priorities, solve past positions on the
board, return later to due positions, and see new-game pattern frequency improve. Tests,
builds, and a rendered UI review must pass, and the cold/warm performance gates must be
measured on the Saint_Uwe corpus rather than inferred from unit tests.
