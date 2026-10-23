import { useCallback } from 'react'

import { useEngine } from '@/hooks/use-engine'
import { buildFullGameLine } from '@/lib/analysis/active-line'
import { prefetchBookPlies } from '@/lib/analysis/book-moves'
import { GAME_REVIEW_DEPTH } from '@/lib/analysis/review-depth'
import { api } from '@/lib/api'
import { useGameLine } from '@/hooks/use-game-line'
import { useAppStore, type ReplayMove } from '@/store/app-store'

/**
 * Runs the engine over the whole line currently on the board — the action
 * behind "Analyze line" and behind the Review panel's own button, so both
 * start the same run at the same depth.
 */
export function useAnalyzeLine() {
  const setBookPlies = useAppStore((state) => state.setBookPlies)
  const setAnalysisRequested = useAppStore((state) => state.setAnalysisRequested)
  const { analyze, queueReplayAnalysis, enabled } = useEngine({ autoAnalyze: false })
  // Only for `canAnalyze`, a button's state, which belongs to the render.
  const rendered = useGameLine()

  const preloadBookPlies = useCallback(
    async (requestFenHistory: string[], requestReplayMoves: ReplayMove[]) => {
      if (!requestReplayMoves.length) {
        setBookPlies([])
        return
      }

      const result = await prefetchBookPlies({
        fenHistory: requestFenHistory,
        fetchTheoryCompare: async (fen) => {
          try {
            const response = await api.get<{
              master_moves: Array<{ san: string; uci?: string | null }>
            }>('/api/theory/compare', { params: { fen } })
            return response.data
          } catch {
            return null
          }
        },
        replayMoves: requestReplayMoves,
      })
      setBookPlies(result.plies)
      if (result.hadErrors) {
        console.warn(
          '[chessgod] Book moves partially loaded — theory API returned errors for some positions.',
        )
      }
    },
    [setBookPlies],
  )

  const analyzeLine = useCallback(
    async ({ depth = GAME_REVIEW_DEPTH }: { depth?: number } = {}) => {
      // The whole game, read from the store at the moment of the call: a
      // freshly loaded game leaves the cursor at the start, and a line taken
      // from the render that handed out this callback could still be the
      // previous board (a saved game opened and reviewed in the same tick
      // analysed one empty position instead of its 67 moves).
      const { nodes, currentNodeId } = useAppStore.getState()
      const { fenHistory, replayMoves } = buildFullGameLine(nodes, currentNodeId)
      const requestFenHistory = [...fenHistory]
      const requestReplayMoves = [...replayMoves]

      setAnalysisRequested(true)
      let didWarmStartEngine = false

      if (!enabled) {
        await analyze()
        didWarmStartEngine = true
      }

      if (requestFenHistory.length > 1) {
        // Explicit depth, not the interactive selector: see GAME_REVIEW_DEPTH.
        await queueReplayAnalysis(requestFenHistory, { depth })
      } else if (!didWarmStartEngine) {
        await analyze()
      }

      void preloadBookPlies(requestFenHistory, requestReplayMoves).catch((err) => {
        console.warn('[chessgod] Failed to load book moves:', err)
      })
    },
    [analyze, enabled, preloadBookPlies, queueReplayAnalysis, setAnalysisRequested],
  )

  return { analyzeLine, canAnalyze: rendered.fenHistory.length > 1 }
}
