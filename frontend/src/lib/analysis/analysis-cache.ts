import { GAME_REVIEW_DEPTH, MIN_TRUSTED_DEPTH } from './review-depth'

export function retainDeeperAnalysis<T extends { depth: number }>(
  existing: T | undefined,
  incoming: T,
): T {
  return existing && existing.depth > incoming.depth ? existing : incoming
}

type AnalysisLine = {
  depth: number
  multipv: number
  pv: string[]
}

type MergeableAnalysis = {
  depth: number
  bestMove: string | null
  lines: AnalysisLine[]
  /**
   * The rank-one line searched at about the review depth, kept beside `lines`
   * so a deeper look at the board never replaces the evaluation a game review
   * grades moves from. See `reviewLineOf`.
   */
  reviewLine?: AnalysisLine
  persisted?: boolean
  /**
   * Whether the kept `reviewLine` is already stored on the server. `persisted`
   * speaks for `lines` only: a review search that lands beside a deeper stored
   * board search leaves `lines` untouched and persisted, and without its own
   * flag the review-depth row was never uploaded.
   */
  reviewLinePersisted?: boolean
}

/**
 * Whether `line`, a review line read out of `analysis` by `reviewLineOf`, is
 * stored on the server: the kept line answers to its own flag, a line still in
 * `lines` to the snapshot's.
 */
function reviewLineStored(analysis: MergeableAnalysis, line: AnalysisLine) {
  return line === analysis.reviewLine
    ? analysis.reviewLinePersisted === true
    : analysis.persisted === true
}

/**
 * Two searches whose depths differ by more than this are not compared. The
 * backend's `MAX_PAIR_DEPTH_GAP` (engine_contract.py) is the same number:
 * Stockfish reports the depth it finished on, so a run asked for 20 can store
 * 21, while a parent at 30 differenced against a child at 20 charges the gap
 * between two searches to the player.
 */
export const MAX_PAIR_DEPTH_GAP = 2

/** The deepest search that still counts as one at the review depth. */
const REVIEW_BAND_MAX = GAME_REVIEW_DEPTH + MAX_PAIR_DEPTH_GAP

/** Whether a search depth pairs with a game review's: 18 to 22. */
export function isReviewBandDepth(depth: number) {
  return depth >= MIN_TRUSTED_DEPTH && depth <= REVIEW_BAND_MAX
}

/** Of two review-band lines, the one closer to the review depth; ties to the deeper. */
function closerToReview<L extends AnalysisLine>(left: L | undefined, right: L | undefined) {
  if (!left) return right
  if (!right) return left
  const leftGap = Math.abs(left.depth - GAME_REVIEW_DEPTH)
  const rightGap = Math.abs(right.depth - GAME_REVIEW_DEPTH)
  if (leftGap !== rightGap) return leftGap < rightGap ? left : right
  return right.depth >= left.depth ? right : left
}

/**
 * The rank-one line a game review grades from: the kept `reviewLine`, else a
 * rank-one line in `lines` that was itself searched at about the review depth.
 * Null when the position was only ever searched shallower or deeper.
 */
export function reviewLineOf<L extends AnalysisLine>(
  analysis: { lines: L[]; reviewLine?: L } | null | undefined,
): L | null {
  if (!analysis) return null
  const fromLines = analysis.lines.find(
    (line) => line.multipv === 1 && isReviewBandDepth(line.depth),
  )
  return closerToReview(analysis.reviewLine, fromLines) ?? null
}

/**
 * Merge per-variation engine snapshots without throwing away useful lines.
 *
 * A deeper rank-one search and a shallower MultiPV search are both useful: the
 * former is the trusted primary evaluation, while the latter supplies legal
 * alternatives for coaching. Keeping one whole snapshot based only on its
 * aggregate depth either loses those alternatives or causes the same search to
 * run forever.
 */
export function mergeEngineAnalysis<T extends MergeableAnalysis>(
  existing: T | undefined,
  incoming: T,
): T {
  if (!existing) return incoming
  const existingReview = reviewLineOf(existing) ?? undefined
  const reviewLine = closerToReview(existingReview, reviewLineOf(incoming) ?? undefined)

  const byVariation = new Map<number, AnalysisLine>()
  for (const line of existing.lines) byVariation.set(line.multipv, line)
  for (const line of incoming.lines) {
    const previous = byVariation.get(line.multipv)
    if (!previous || line.depth >= previous.depth) byVariation.set(line.multipv, line)
  }

  // A move can change rank between searches. Keep its preferred rank once;
  // duplicates are not independent alternatives and must not satisfy MultiPV
  // coverage or be uploaded as separate coaching evidence.
  const seenMoves = new Set<string>()
  const lines = [...byVariation.values()]
    .sort((left, right) => left.multipv - right.multipv)
    .filter((line) => {
      const move = line.pv[0]
      if (!move || seenMoves.has(move)) return false
      seenMoves.add(move)
      return true
    })
  if (
    lines.length === existing.lines.length &&
    lines.every((line, index) => line === existing.lines[index]) &&
    (reviewLine ?? null) === reviewLineOf(existing)
  ) {
    return existing
  }
  const primary = lines.find((line) => line.multipv === 1)
  const merged: T = {
    ...existing,
    ...incoming,
    bestMove: primary?.pv[0] ?? incoming.bestMove ?? existing.bestMove,
    depth: primary?.depth ?? Math.max(existing.depth, incoming.depth),
    lines,
    // The upload hook skips persisted snapshots. A mixed snapshot is only
    // persisted when every retained line came from a persisted source.
    persisted: lines.every((line) =>
      incoming.lines.includes(line) ? incoming.persisted === true : existing.persisted === true,
    ),
  }
  // Kept apart only once a deeper search has displaced it from `lines`, and
  // then with the persistence of the snapshot it came from, not of `lines`.
  const kept = merged as MergeableAnalysis
  if (reviewLine && !lines.includes(reviewLine)) {
    kept.reviewLine = reviewLine
    kept.reviewLinePersisted = reviewLineStored(
      reviewLine === existingReview ? existing : incoming,
      reviewLine,
    )
  } else {
    delete kept.reviewLine
    delete kept.reviewLinePersisted
  }
  return merged
}

export function needsEngineAnalysis(
  cachedDepth: number | null,
  requestedDepth: number,
  force = false,
  cachedMultiPV = 1,
  requestedMultiPV = 1,
) {
  if (force) {
    return true
  }

  if (cachedDepth == null) {
    return true
  }

  return cachedDepth < requestedDepth || cachedMultiPV < requestedMultiPV
}
