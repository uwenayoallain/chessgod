"""The single analysis engine accepted and served by ChessGod."""

ENGINE_NAME = "stockfish-19"
ENGINE_VERSION = "19"

# An evaluation loss is the difference between two searches, so the two sides of
# a decision must be searched to comparable depths. Stockfish reports the depth
# it finished on, so a run asked for depth 22 can store 23; that much is noise.
# A depth-30 parent against a depth-22 child is not — the gap alone can move the
# score by more than the blunder threshold, which invents mistakes the player
# never made. Pairs wider than this are left unmeasured until the shallower side
# is deepened.
MAX_PAIR_DEPTH_GAP = 2

# The depth an "analyse my own games" run searches to — the browser's library
# crawl, a single-game review, and the headless background crawler alike. It is
# not the interactive depth (30): reviewing a 120-ply game at 30 takes about
# fifty minutes, and more importantly every path that fills the library has to
# agree on one number, or a parent searched by one and a child by another are
# differenced across depths they never shared.
#
# Distinct from MIN_TRUSTED_DEPTH below: this is what a crawl *targets*, that is
# the shallowest reading anything may be *graded* from. Using the floor as the
# target — which the background crawler did at first — fills the library at a
# depth the browser's own coverage query does not count, so the work is redone.
#
# The frontend keeps the same number in `lib/analysis/review-depth.ts`;
# tests/test_engine_contract.py fails if the two drift apart.
GAME_REVIEW_DEPTH = 22

# The shallowest search a decision may be graded from. Evaluations below this
# are kept — they still pair with each other — but the learning surfaces ignore
# them rather than teach from a reading too shallow to trust.
MIN_TRUSTED_DEPTH = 18


# The largest centipawn score a learning query will difference. Stockfish scores
# won endgames far past any human scale — tablebase-backed wins arrive as
# 8,000-20,000 — so a king move from one such score to a draw measured as
# "80.4 pawns lost", and because candidates are ranked by the drop, those
# endgames filled the drill pool ahead of every ordinary blunder: 132 of the
# first 1,000 candidates were over 2,000cp. Past about fifteen pawns the figure
# says only "decisive", so it is capped there. It stays below the mate scale
# (1,800-1,990, see the eval CASE in the learning queries) so a forced mate
# still outranks any centipawn score. Nothing is dropped by this: every mistake
# over the threshold remains a candidate, only its size is kept honest.
DECISIVE_CP = 1500
