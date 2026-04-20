import { useMemo } from 'react'

import { buildActiveReplayLine } from '@/lib/analysis/active-line'
import { useAppStore } from '@/store/app-store'

export function useActiveReplayLine() {
  const nodes = useAppStore((state) => state.nodes)
  const currentNodeId = useAppStore((state) => state.currentNodeId)

  return useMemo(() => buildActiveReplayLine(nodes, currentNodeId), [currentNodeId, nodes])
}
