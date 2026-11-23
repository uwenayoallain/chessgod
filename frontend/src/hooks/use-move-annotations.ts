import { useMemo } from 'react'

import { buildActiveReplayLine, type ActiveReplayLine } from '@/lib/analysis/active-line'
import {
  buildReplayMoveAnnotations,
  type ReplayMoveAnnotation,
} from '@/lib/analysis/replay-annotations'
import { useEngineStore } from '@/store/engine-store'
import { useAppStore, type ReplayMove } from '@/store/app-store'

type AnalysisByFen = ReturnType<typeof useEngineStore.getState>['analysisByFen']

const NO_ANNOTATIONS: ReplayMoveAnnotation[] = []

type Graded = {
  analysisByFen: AnalysisByFen
  bookPlies: number[]
  hasLoadedLine: boolean
  fenHistory: string[]
  result: ReplayMoveAnnotation[]
}

/**
 * The last grading of each line, keyed on the line's own moves. Lines are
 * shared objects (see `buildActiveReplayLine`), so the board, the move list
 * and the review asking about one line grade it once between them.
 */
const gradedByLine = new WeakMap<ReplayMove[], Graded>()

function sameAnnotation(a: ReplayMoveAnnotation, b: ReplayMoveAnnotation) {
  return (
    a.label === b.label &&
    a.cpLoss === b.cpLoss &&
    a.bestMove === b.bestMove &&
    a.fen === b.fen &&
    a.uci === b.uci &&
    a.ply === b.ply &&
    a.san === b.san
  )
}

/**
 * Structural sharing between two gradings of a line: a move whose label, loss
 * and best move did not change keeps the object it had, and when no move
 * changed the previous array itself comes back. A review reports a position
 * several times a second, and almost every report leaves almost every move
 * as it was; identity is what lets everything memoised on a move, or on the
 * list, skip the work.
 */
export function shareAnnotations(
  previous: ReplayMoveAnnotation[] | undefined,
  next: ReplayMoveAnnotation[],
): ReplayMoveAnnotation[] {
  if (!previous) return next
  let reusedAll = previous.length === next.length
  const shared = next.map((annotation, index) => {
    const before = previous[index]
    if (before && sameAnnotation(before, annotation)) return before
    reusedAll = false
    return annotation
  })
  return reusedAll ? previous : shared
}

/**
 * Grade a line against the evaluations in hand. Returns the same array for
 * the same inputs, and for inputs that changed without changing any move.
 */
export function annotateLine({
  analysisByFen,
  bookPlies,
  hasLoadedLine,
  line,
}: {
  analysisByFen: AnalysisByFen
  bookPlies: number[]
  hasLoadedLine: boolean
  line: Pick<ActiveReplayLine, 'fenHistory' | 'replayMoves'>
}): ReplayMoveAnnotation[] {
  const { fenHistory, replayMoves } = line
  if (!replayMoves.length) return NO_ANNOTATIONS

  const before = gradedByLine.get(replayMoves)
  if (
    before &&
    before.analysisByFen === analysisByFen &&
    before.bookPlies === bookPlies &&
    before.hasLoadedLine === hasLoadedLine &&
    before.fenHistory === fenHistory
  ) {
    return before.result
  }

  const result = shareAnnotations(
    before?.result,
    buildReplayMoveAnnotations({
      analysisByFen,
      bookPlies: new Set(bookPlies),
      fenHistory,
      implicitBookPlyLimit: hasLoadedLine ? 12 : 0,
      replayMoves,
    }),
  )
  gradedByLine.set(replayMoves, { analysisByFen, bookPlies, hasLoadedLine, fenHistory, result })
  return result
}

/**
 * Move-quality labels for a line. Defaults to the line leading to the board's
 * current position; pass a line (see `useGameLine`) to grade a whole game.
 *
 * The engine store is read through a selector that returns the graded array,
 * and that array keeps its identity until a move's grade actually changes, so
 * a caller re-renders when its own line is graded differently and not on every
 * position the engine finishes anywhere.
 */
export function useMoveAnnotations(line?: ActiveReplayLine) {
  // With a line given the board's own line is neither built nor subscribed to:
  // the caller is not following the cursor and must not re-render when it moves.
  const nodes = useAppStore((state) => (line ? null : state.nodes))
  const currentNodeId = useAppStore((state) => (line ? null : state.currentNodeId))
  const target = useMemo(
    () => line ?? (nodes && currentNodeId ? buildActiveReplayLine(nodes, currentNodeId) : null),
    [currentNodeId, line, nodes],
  )
  const bookPlies = useAppStore((state) => state.bookPlies)
  const hasLoadedLine = useAppStore((state) => state.hasLoadedLine)

  return useEngineStore((state) =>
    target
      ? annotateLine({
          analysisByFen: state.analysisByFen,
          bookPlies,
          hasLoadedLine,
          line: target,
        })
      : NO_ANNOTATIONS,
  )
}
