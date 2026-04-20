import { useMemo } from 'react'

import { buildReplayMoveAnnotations } from '@/lib/analysis/replay-annotations'
import { useEngineStore } from '@/store/engine-store'
import { STARTING_FEN, useAppStore } from '@/store/app-store'

export function useMoveAnnotations() {
  const nodes = useAppStore((state) => state.nodes)
  const mainLine = useAppStore((state) => state.mainLine)
  const bookPlies = useAppStore((state) => state.bookPlies)
  const hasLoadedLine = useAppStore((state) => state.hasLoadedLine)
  const analysisByFen = useEngineStore((state) => state.analysisByFen)
  const _version = useEngineStore((state) => state.analysisVersion)

  return useMemo(() => {
    if (!mainLine.length) return []

    const replayMoves = mainLine
      .map((id) => nodes[id])
      .filter((n) => n?.san)
      .map((n) => ({ ply: n.ply, san: n.san!, uci: n.uci ?? '', fen: n.fen }))

    const fenHistory = [STARTING_FEN, ...replayMoves.map((m) => m.fen)]

    return buildReplayMoveAnnotations({
      analysisByFen,
      bookPlies: new Set(bookPlies),
      fenHistory,
      implicitBookPlyLimit: hasLoadedLine ? 12 : 0,
      replayMoves,
    })
  }, [analysisByFen, _version, bookPlies, hasLoadedLine, mainLine, nodes])
}
