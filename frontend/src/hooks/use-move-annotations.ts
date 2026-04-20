import { useMemo } from 'react'

import { useActiveReplayLine } from '@/hooks/use-active-replay-line'
import { buildReplayMoveAnnotations } from '@/lib/analysis/replay-annotations'
import { useEngineStore } from '@/store/engine-store'
import { useAppStore } from '@/store/app-store'

export function useMoveAnnotations() {
  const { fenHistory, replayMoves } = useActiveReplayLine()
  const bookPlies = useAppStore((state) => state.bookPlies)
  const hasLoadedLine = useAppStore((state) => state.hasLoadedLine)
  const analysisByFen = useEngineStore((state) => state.analysisByFen)
  const _version = useEngineStore((state) => state.analysisVersion)

  return useMemo(() => {
    if (!replayMoves.length) return []

    return buildReplayMoveAnnotations({
      analysisByFen,
      bookPlies: new Set(bookPlies),
      fenHistory,
      implicitBookPlyLimit: hasLoadedLine ? 12 : 0,
      replayMoves,
    })
  }, [analysisByFen, _version, bookPlies, hasLoadedLine, fenHistory, replayMoves])
}
