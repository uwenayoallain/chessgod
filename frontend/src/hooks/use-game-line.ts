import { useMemo } from 'react'

import { useMoveAnnotations } from '@/hooks/use-move-annotations'
import { buildActiveReplayLine, mainLineLeafId } from '@/lib/analysis/active-line'
import { useAppStore } from '@/store/app-store'

/**
 * The whole loaded game, wherever the cursor happens to be: the unit a review
 * works on. Use `useActiveReplayLine` instead for anything that should follow
 * the board.
 *
 * Keyed on the main line's last node rather than on the cursor. Every position
 * of a game shares that leaf, so stepping through the game returns the same
 * line object and nothing built from it (the eval graph, the review summary,
 * the retry list) recomputes. The selector returns a string, so a step inside
 * the game does not even re-render the caller.
 */
export function useGameLine() {
  const nodes = useAppStore((state) => state.nodes)
  const leafId = useAppStore((state) => mainLineLeafId(state.nodes, state.currentNodeId))

  return useMemo(() => buildActiveReplayLine(nodes, leafId), [leafId, nodes])
}

/**
 * The loaded game and its grades, for the components that show a review. Call
 * it where the review is drawn, not in a layout root: the grades change while
 * a review runs, and whatever calls this re-renders with them. Every caller
 * shares one line object and one grading (see `annotateLine`), so three
 * components reading the review cost one build between them.
 */
export function useGameReview() {
  const line = useGameLine()
  const annotations = useMoveAnnotations(line)
  return { line, annotations }
}
