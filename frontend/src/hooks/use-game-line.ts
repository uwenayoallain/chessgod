import { useMemo } from 'react'

import { buildFullGameLine } from '@/lib/analysis/active-line'
import { useAppStore } from '@/store/app-store'

/**
 * The whole loaded game, wherever the cursor happens to be — the unit a review
 * works on. Use `useActiveReplayLine` instead for anything that should follow
 * the board.
 */
export function useGameLine() {
  const nodes = useAppStore((state) => state.nodes)
  const currentNodeId = useAppStore((state) => state.currentNodeId)

  return useMemo(() => buildFullGameLine(nodes, currentNodeId), [currentNodeId, nodes])
}
