import { useCallback, useMemo } from 'react'

import { AnnotationIcon, annotationTitle } from '@/components/ui/annotation-icon'
import { useMoveAnnotations } from '@/hooks/use-move-annotations'
import { buildGuidanceArrows, type BoardArrow } from '@/lib/analysis/board-guidance'
import { buildReplayMoveAnnotations } from '@/lib/analysis/replay-annotations'
import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'
import type { ReplayMoveAnnotation } from '@/lib/analysis/replay-annotations'

function uciToSquare(uci: string): string {
  return uci.slice(2, 4)
}

function useCurrentMoveAnnotation(): ReplayMoveAnnotation | null {
  const mainLineAnnotations = useMoveAnnotations()
  const nodes = useAppStore((state) => state.nodes)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const mainLine = useAppStore((state) => state.mainLine)
  const bookPlies = useAppStore((state) => state.bookPlies)
  const hasLoadedLine = useAppStore((state) => state.hasLoadedLine)
  const analysisByFen = useEngineStore((state) => state.analysisByFen)
  const _version = useEngineStore((state) => state.analysisVersion)

  return useMemo(() => {
    const currentNode = nodes[currentNodeId]
    if (!currentNode?.uci || !currentNode?.san) return null

    const mainLineIdx = mainLine.indexOf(currentNodeId)
    if (mainLineIdx >= 0 && mainLineAnnotations[mainLineIdx]?.label) {
      return mainLineAnnotations[mainLineIdx]
    }

    const parentNode = currentNode.parentId ? nodes[currentNode.parentId] : null
    if (!parentNode) return null

    const pathMoves = [{ ply: currentNode.ply, san: currentNode.san, uci: currentNode.uci, fen: currentNode.fen }]
    const pathFenHistory = [parentNode.fen, currentNode.fen]

    const annotations = buildReplayMoveAnnotations({
      analysisByFen,
      bookPlies: new Set(bookPlies),
      fenHistory: pathFenHistory,
      implicitBookPlyLimit: hasLoadedLine ? 12 : 0,
      replayMoves: pathMoves,
    })

    return annotations[0] ?? null
  }, [mainLineAnnotations, nodes, currentNodeId, mainLine, bookPlies, hasLoadedLine, analysisByFen, _version])
}

export function useMoveMarkers(showAnnotations: boolean = true) {
  const annotation = useCurrentMoveAnnotation()

  const currentFen = useAppStore((state) => state.currentFen)
  const analysisByFen = useEngineStore((state) => state.analysisByFen)
  const engineBestMove = useEngineStore((state) => state.bestMove)
  const analyzedFen = useEngineStore((state) => state.analyzedFen)

  const markersBySquare = useMemo(() => {
    const map = new Map<string, NonNullable<ReplayMoveAnnotation['label']>>()
    if (showAnnotations && annotation?.label && annotation.uci) {
      map.set(uciToSquare(annotation.uci), annotation.label)
    }
    return map
  }, [annotation, showAnnotations])

  const customArrows: BoardArrow[] = useMemo(() => {
    const currentAnalysisBestMove =
      analysisByFen[currentFen]?.bestMove ??
      (analyzedFen === currentFen ? engineBestMove : null)

    return buildGuidanceArrows({
      bestMove: currentAnalysisBestMove,
      fen: currentFen,
    })
  }, [engineBestMove, analyzedFen, analysisByFen, currentFen])

  const squareRenderer = useCallback(
    ({ square, children }: { piece: unknown; square: string; children?: React.ReactNode }) => {
      const label = markersBySquare.get(square)

      return (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          {children}
          {label ? (
            <div
              className="board-move-marker"
              title={annotationTitle(label)}
            >
              <AnnotationIcon label={label} size={32} />
            </div>
          ) : null}
        </div>
      )
    },
    [markersBySquare],
  )

  return { squareRenderer, hasMarkers: markersBySquare.size > 0, customArrows }
}
