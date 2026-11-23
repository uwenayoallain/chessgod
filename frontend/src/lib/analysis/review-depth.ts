/**
 * The depth every "analyse my own games" run uses — the library crawl in
 * `EngineAnalyzeBatch` and a single-game review from the board rail alike.
 *
 * It is deliberately NOT the interactive depth from the engine's depth
 * selector. Reviewing a 120-ply game at the interactive default takes the best
 * part of an hour; at this depth, on the review pool, it is about half a
 * minute. More importantly, the
 * two paths have to agree with each other: mistake detection differences a
 * parent eval against a child eval, so a line analysed at mixed depths reads
 * as a string of eval drops that never happened.
 *
 * `GET /api/games/unanalyzed-fens?min_depth=` is asked the same number, so a
 * position analysed by either path counts as covered by both.
 */
export const GAME_REVIEW_DEPTH = 20

/**
 * The shallowest search a move may be graded from, and the shallowest the
 * browser uploads. The backend's `MIN_TRUSTED_DEPTH` (engine_contract.py) is
 * the same number. 20 above sits two plies over it, so a search cut short by
 * its time limit at 18 or 19 still pairs with one that reached 20, and 20
 * still pairs with the library's older rows at 22.
 */
export const MIN_TRUSTED_DEPTH = 18

/**
 * The largest centipawn score a move grade is measured from. Stockfish reports
 * tablebase-backed wins as 8,000-20,000, and one such swing turned a game's
 * average loss into hundreds of centipawns. Past this the score only says
 * "decisive". Below the mate scale (1,800-1,990) so a mate still outranks it.
 * The backend caps its learning queries at the same number
 * (`DECISIVE_CP`, engine_contract.py); tests/test_engine_contract.py keeps
 * them equal.
 */
export const DECISIVE_CP = 1500

/**
 * The depth a finished game against the engine is reviewed at. Those games are
 * not in the library, so they need not match the crawl's depth; this is the
 * shallowest depth a move grade trusts (`replay-annotations` reads nothing
 * shallower), and it makes a 75-position review about a third as long.
 */
export const QUICK_REVIEW_DEPTH = 18
