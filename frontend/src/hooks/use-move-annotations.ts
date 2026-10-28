import { useMemo } from 'react'

import { useActiveReplayLine } from '@/hooks/use-active-replay-line'
import type { ActiveReplayLine } from '@/lib/analysis/active-line'
import { buildReplayMoveAnnotations } from '@/lib/analysis/replay-annotations'
import { useEngineStore } from '@/store/engine-store'
import { useAppStore } from '@/store/app-store'

/**
 * Move-quality labels for a line. Defaults to the line leading to the board's
 * current position; pass a line (see `useGameLine`) to grade a whole game.
 */
export function useMoveAnnotations(line?: ActiveReplayLine) {
  const active = useActiveReplayLine()
  const { fenHistory, replayMoves } = line ?? active
  const bookPlies = useAppStore((state) => state.bookPlies)
  const hasLoadedLine = useAppStore((state) => state.hasLoadedLine)
  // Read analysisByFen imperatively; _version is the reactivity gate.
  // This prevents a re-run whenever any unrelated position is analyzed.
  const _version = useEngineStore((state) => state.analysisVersion)

  return useMemo(() => {
    if (!replayMoves.length) return []

    const analysisByFen = useEngineStore.getState().analysisByFen
    return buildReplayMoveAnnotations({
      analysisByFen,
      bookPlies: new Set(bookPlies),
      fenHistory,
      implicitBookPlyLimit: hasLoadedLine ? 12 : 0,
      replayMoves,
    })
  }, [_version, bookPlies, hasLoadedLine, fenHistory, replayMoves])
}
