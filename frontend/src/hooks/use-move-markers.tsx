import { useCallback, useMemo, type CSSProperties } from 'react'

import { AnnotationIcon, annotationTitle } from '@/components/ui/annotation-icon'
import { useActiveReplayLine } from '@/hooks/use-active-replay-line'
import { useMoveAnnotations } from '@/hooks/use-move-annotations'
import { buildGuidanceArrows, type BoardArrow } from '@/lib/analysis/board-guidance'
import { buildBookMarkers, bookMarkerTitle } from '@/lib/analysis/book-markers'
import { buildReplayMoveAnnotations } from '@/lib/analysis/replay-annotations'
import { useTheory } from '@/hooks/use-theory'
import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'
import { useIsSparring } from '@/store/spar-store'
import type { ReplayMoveAnnotation } from '@/lib/analysis/replay-annotations'

function uciToSquare(uci: string): string {
  return uci.slice(2, 4)
}

function useCurrentMoveAnnotation(): ReplayMoveAnnotation | null {
  const mainLineAnnotations = useMoveAnnotations()
  const { nodeIds: activeLineNodeIds } = useActiveReplayLine()
  const nodes = useAppStore((state) => state.nodes)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const bookPlies = useAppStore((state) => state.bookPlies)
  const hasLoadedLine = useAppStore((state) => state.hasLoadedLine)
  // Do not subscribe to analysisByFen directly — it gets a new object reference
  // on every analysis completion, causing all markers to recompute even when
  // the current position's cache entry hasn't changed. Read it imperatively
  // inside the memo instead; _version is the sole reactivity gate.
  const _version = useEngineStore((state) => state.analysisVersion)

  return useMemo(() => {
    const analysisByFen = useEngineStore.getState().analysisByFen
    const currentNode = nodes[currentNodeId]
    if (!currentNode?.uci || !currentNode?.san) return null

    const mainLineIdx = activeLineNodeIds.indexOf(currentNodeId)
    if (mainLineIdx >= 0 && mainLineAnnotations[mainLineIdx]?.label) {
      return mainLineAnnotations[mainLineIdx]
    }

    const parentNode = currentNode.parentId ? nodes[currentNode.parentId] : null
    if (!parentNode) return null

    const pathMoves = [
      { ply: currentNode.ply, san: currentNode.san, uci: currentNode.uci, fen: currentNode.fen },
    ]
    const pathFenHistory = [parentNode.fen, currentNode.fen]

    const annotations = buildReplayMoveAnnotations({
      analysisByFen,
      bookPlies: new Set(bookPlies),
      fenHistory: pathFenHistory,
      implicitBookPlyLimit: hasLoadedLine ? 12 : 0,
      replayMoves: pathMoves,
    })

    return annotations[0] ?? null
  }, [
    mainLineAnnotations,
    activeLineNodeIds,
    nodes,
    currentNodeId,
    bookPlies,
    hasLoadedLine,
    _version,
  ])
}

/**
 * react-chessboard only applies its own `squareStyles` on the fallback square
 * it renders itself — supplying a `squareRenderer` silently drops them. Since
 * this board always supplies one (for classification badges), the highlight
 * styles have to be merged in here or last-move, selection and legal-move
 * markers never paint.
 */
export function useMoveMarkers(
  showAnnotations: boolean = true,
  squareStyles: Record<string, CSSProperties> = {},
) {
  const annotation = useCurrentMoveAnnotation()

  const currentFen = useAppStore((state) => state.currentFen)
  const isSolvingDrill = useAppStore((state) => state.drillSolving)
  const trainerArrows = useAppStore((state) => state.trainerArrows)
  const trainerArrowsFen = useAppStore((state) => state.trainerArrowsFen)
  const hintSquare = useAppStore((state) => state.hintSquare)
  const hintSquareFen = useAppStore((state) => state.hintSquareFen)
  // The hint's ring shows on the question's board alone.
  const hintOn =
    hintSquare != null &&
    (hintSquareFen == null ||
      hintSquareFen.split(' ', 4).join(' ') === currentFen.split(' ', 4).join(' '))
      ? hintSquare
      : null
  const sparring = useIsSparring()
  const _arrowVersion = useEngineStore((state) => state.analysisVersion)
  const engineBestMove = useEngineStore((state) => state.bestMove)
  const analyzedFen = useEngineStore((state) => state.analyzedFen)

  // Shares TanStack Query's cache with the Theory panel, so marking the board
  // costs no extra request. Master moves are only ever read here — never
  // fetched on demand — so a position without book data simply has no markers.
  const { data: theory } = useTheory(currentFen)

  const bookMarkers = useMemo(() => {
    // A book move is an answer to the question a drill is asking.
    if (isSolvingDrill || !showAnnotations) return {}
    return buildBookMarkers({ masterMoves: theory?.master_moves, fen: currentFen })
  }, [theory, currentFen, isSolvingDrill, showAnnotations])

  const markersBySquare = useMemo(() => {
    const map = new Map<string, NonNullable<ReplayMoveAnnotation['label']>>()
    if (showAnnotations && annotation?.label && annotation.uci) {
      map.set(uciToSquare(annotation.uci), annotation.label)
    }
    return map
  }, [annotation, showAnnotations])

  const customArrows: BoardArrow[] = useMemo(() => {
    // A trainer's own arrows are the lesson; nothing else may compete with them.
    // Arrows scoped to a position apply there alone: the moment the board moves
    // on, they are gone rather than pointing at squares of another game.
    const arrowsApply =
      trainerArrowsFen == null ||
      trainerArrowsFen.split(' ', 4).join(' ') === currentFen.split(' ', 4).join(' ')
    if (trainerArrows.length && arrowsApply) return trainerArrows
    // The engine's best move and the opponent's hanging-piece threat are both
    // answers to the question a drill is asking, so neither is drawn while
    // solving — nor during a game against the engine, where every move is one.
    if (isSolvingDrill || sparring) return []
    const analysisByFen = useEngineStore.getState().analysisByFen
    const currentAnalysisBestMove =
      analysisByFen[currentFen]?.bestMove ?? (analyzedFen === currentFen ? engineBestMove : null)

    return buildGuidanceArrows({
      bestMove: currentAnalysisBestMove,
      fen: currentFen,
    })
  }, [
    engineBestMove,
    analyzedFen,
    _arrowVersion,
    currentFen,
    isSolvingDrill,
    sparring,
    trainerArrows,
    trainerArrowsFen,
  ])

  const squareRenderer = useCallback(
    ({ square, children }: { piece: unknown; square: string; children?: React.ReactNode }) => {
      const label = markersBySquare.get(square)
      const book = bookMarkers[square]

      return (
        <div
          style={{ position: 'relative', width: '100%', height: '100%', ...squareStyles[square] }}
        >
          {hintOn === square ? (
            // The whole square lit, under the piece: the mark chess sites use
            // for "look here". A ring was mostly hidden by the piece on it.
            <div aria-hidden="true" className="board-hint-square" />
          ) : null}
          {children}
          {label ? (
            <div className="board-move-marker" title={annotationTitle(label)}>
              <AnnotationIcon label={label} size={32} />
            </div>
          ) : null}
          {book ? (
            // Bottom-left, because the classification badge owns the top-right
            // corner and the two must never sit on top of each other.
            <div
              className={`board-book-marker board-book-marker--${book.rank}`}
              title={bookMarkerTitle(book)}
            >
              {book.share >= 0.1 ? `${Math.round(book.share * 100)}%` : '·'}
            </div>
          ) : null}
        </div>
      )
    },
    [markersBySquare, bookMarkers, squareStyles, hintOn],
  )

  return {
    squareRenderer,
    hasMarkers: markersBySquare.size > 0,
    bookMarkerCount: Object.keys(bookMarkers).length,
    customArrows,
  }
}
