import type { ReplayMoveAnnotation } from './replay-annotations'

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
  const mine = annotations.filter((annotation) => sideOfPly(annotation.ply) === side)
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
