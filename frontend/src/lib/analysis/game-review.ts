import { moverCpOf, type ReplayMoveAnnotation } from './replay-annotations'
import type { CachedEngineAnalysis } from '@/store/engine-store'

export type ReviewLabel = NonNullable<ReplayMoveAnnotation['label']>

/** Best-to-worst, which is the order they are shown in. */
export const REVIEW_LABELS = [
  'Brilliant',
  'Best',
  'Excellent',
  'Good',
  'Book',
  'Inaccuracy',
  'Mistake',
  'Missed Win',
  'Blunder',
] as const satisfies readonly ReviewLabel[]

const COSTLY: ReadonlySet<ReviewLabel> = new Set(['Inaccuracy', 'Mistake', 'Blunder'])

export type SideReview = {
  /** Moves this side played in the line. */
  moves: number
  /** Of those, how many the engine has evaluated on both sides of the move. */
  judged: number
  counts: Record<ReviewLabel, number>
  /** Mean centipawn loss over judged moves — null until something is judged. */
  averageLossCp: number | null
  /** Inaccuracies, mistakes and blunders, most expensive first. */
  costly: ReplayMoveAnnotation[]
}

export function sideOfPly(ply: number): 'white' | 'black' {
  return ply % 2 === 1 ? 'white' : 'black'
}

/**
 * Who played a move: the opposite of the side to move after it. Ply parity
 * only holds for a game from the starting position; a position played out
 * against the engine can start with Black to move.
 */
function moverOf(annotation: ReplayMoveAnnotation): 'white' | 'black' {
  const side = annotation.fen.split(' ')[1]
  if (side === 'w') return 'black'
  if (side === 'b') return 'white'
  return sideOfPly(annotation.ply)
}

function emptyCounts(): Record<ReviewLabel, number> {
  return Object.fromEntries(REVIEW_LABELS.map((label) => [label, 0])) as Record<ReviewLabel, number>
}

/**
 * Reduces a line's annotations to one side's scoreline. A move counts as
 * judged only once the engine has evaluated the positions either side of it,
 * so the totals grow as an analysis run progresses rather than implying the
 * unanalyzed moves were fine.
 */
export function reviewSide(
  annotations: ReplayMoveAnnotation[],
  side: 'white' | 'black',
): SideReview {
  const mine = annotations.filter((annotation) => moverOf(annotation) === side)
  const counts = emptyCounts()
  let lossTotal = 0
  let judged = 0

  for (const annotation of mine) {
    if (annotation.label) counts[annotation.label] += 1
    if (annotation.cpLoss != null) {
      lossTotal += annotation.cpLoss
      judged += 1
    }
  }

  const costly = mine
    .filter((annotation) => annotation.label != null && COSTLY.has(annotation.label))
    .sort((a, b) => (b.cpLoss ?? 0) - (a.cpLoss ?? 0))

  return {
    moves: mine.length,
    judged,
    counts,
    averageLossCp: judged === 0 ? null : Math.round(lossTotal / judged),
    costly,
  }
}

/** How much of the line the engine has actually judged. */
export function reviewCoverage(annotations: ReplayMoveAnnotation[]) {
  const judged = annotations.filter((annotation) => annotation.cpLoss != null).length
  return { judged, total: annotations.length, complete: judged === annotations.length }
}

/**
 * What a move cost, as something a person can read. Past about ten pawns the
 * exact figure is noise — the position was already lost — so it is capped
 * rather than printed in full.
 */
export function formatCost(cpLoss: number | null): string {
  if (cpLoss == null || !Number.isFinite(cpLoss)) return ''
  const loss = Math.max(0, Math.round(cpLoss))
  if (loss >= 1000) return '\u2212999+'
  return `\u2212${loss}`
}

/** Winning chances from a centipawn evaluation, 0-100: the curve Lichess uses. */
export function winningChances(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)
}

/**
 * How accurate one move was, 0-100, from the winning chances it kept: the
 * Lichess formula, which Chess.com's accuracy resembles. A move the engine
 * would have played is 100; losing ten points of winning chances is ~64.
 */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  if (winAfter >= winBefore) return 100
  const raw = 103.1668 * Math.exp(-0.04354 * (winBefore - winAfter)) - 3.1669
  return Math.max(0, Math.min(100, raw))
}

/**
 * A side's accuracy over its judged moves, or null before anything is judged.
 * Each move's chances before and after come from the evaluations either side
 * of it, from the mover's point of view; a best move counts as 100 whatever
 * the two searches say.
 */
export function sideAccuracy(
  annotations: ReplayMoveAnnotation[],
  fenHistory: string[],
  analysisByFen: Record<string, CachedEngineAnalysis>,
  side: 'white' | 'black',
): number | null {
  let total = 0
  let judged = 0
  annotations.forEach((annotation, index) => {
    if (moverOf(annotation) !== side || annotation.cpLoss == null) return
    const parentFen = fenHistory[index]
    const before = parentFen ? moverCpOf(parentFen, analysisByFen[parentFen]) : null
    const afterOpp = moverCpOf(annotation.fen, analysisByFen[annotation.fen])
    if (before == null || afterOpp == null) return
    const accuracy =
      annotation.cpLoss === 0
        ? 100
        : moveAccuracy(winningChances(before), winningChances(-afterOpp))
    total += accuracy
    judged += 1
  })
  return judged ? Math.round((total / judged) * 10) / 10 : null
}

/** The annotation of the move that led to `fen`, or null at the start of the line. */
export function annotationAtFen(
  annotations: ReplayMoveAnnotation[],
  fen: string | null | undefined,
): ReplayMoveAnnotation | null {
  if (!fen) return null
  return annotations.find((annotation) => annotation.fen === fen) ?? null
}

/** How a move reads in a sentence: "is a blunder", "is the best move". */
export function describeLabel(label: ReviewLabel | null): string {
  switch (label) {
    case 'Brilliant':
      return 'is brilliant'
    case 'Best':
      return 'is the best move'
    case 'Excellent':
      return 'is excellent'
    case 'Good':
      return 'is good'
    case 'Book':
      return 'is a book move'
    case 'Inaccuracy':
      return 'is an inaccuracy'
    case 'Mistake':
      return 'is a mistake'
    case 'Missed Win':
      return 'misses a win'
    case 'Blunder':
      return 'is a blunder'
    default:
      return 'is not judged yet'
  }
}
