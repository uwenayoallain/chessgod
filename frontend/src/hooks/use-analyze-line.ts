import { useCallback } from 'react'

import { useGameLine } from '@/hooks/use-game-line'
import { useEngine } from '@/hooks/use-engine'
import { prefetchBookPlies } from '@/lib/analysis/book-moves'
import { GAME_REVIEW_DEPTH } from '@/lib/analysis/review-depth'
import { api } from '@/lib/api'
import { useAppStore } from '@/store/app-store'

/**
 * Runs the engine over the whole line currently on the board — the action
 * behind "Analyze line" and behind the Review panel's own button, so both
 * start the same run at the same depth.
 */
export function useAnalyzeLine() {
  const setBookPlies = useAppStore((state) => state.setBookPlies)
  const setAnalysisRequested = useAppStore((state) => state.setAnalysisRequested)
  const { analyze, queueReplayAnalysis, enabled } = useEngine({ autoAnalyze: false })
  // The whole game: a freshly loaded game leaves the cursor at the start,
  // and a review scoped to the cursor would cover nothing.
  const { fenHistory, replayMoves } = useGameLine()

  const preloadBookPlies = useCallback(
    async (requestFenHistory: string[], requestReplayMoves: typeof replayMoves) => {
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
    [
      analyze,
      enabled,
      fenHistory,
      preloadBookPlies,
      queueReplayAnalysis,
      replayMoves,
      setAnalysisRequested,
    ],
  )

  return { analyzeLine, canAnalyze: fenHistory.length > 1 }
}
