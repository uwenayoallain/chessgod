import { useCallback } from 'react'

import { analyzeBoard } from '@/hooks/use-engine'
import { buildFullGameLine } from '@/lib/analysis/active-line'
import { BOOK_PREFETCH_PLIES, prefetchBookPlies } from '@/lib/analysis/book-moves'
import { GAME_REVIEW_DEPTH } from '@/lib/analysis/review-depth'
import { api } from '@/lib/api'
import { useGameLine } from '@/hooks/use-game-line'
import { useAppStore, type ReplayMove } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'

// The opening of the line whose book plies were last read here. Loading a game
// already reads them (use-board-workspace), and "Analyze line" right after it
// read them all again; the book can only change where the line does.
let bookReadFor: string | null = null

function openingKey(fenHistory: string[]) {
  return fenHistory.slice(0, BOOK_PREFETCH_PLIES + 1).join('|')
}

function samePlies(left: number[], right: number[]) {
  return left.length === right.length && left.every((ply, index) => ply === right[index])
}

/**
 * Runs the engine over the whole line currently on the board: the action
 * behind "Analyze line" and behind the Review panel's own button, so both
 * start the same run at the same depth.
 */
export function useAnalyzeLine() {
  const setBookPlies = useAppStore((state) => state.setBookPlies)
  const setAnalysisRequested = useAppStore((state) => state.setAnalysisRequested)
  // Only for `canAnalyze`, a button's state, which belongs to the render.
  const rendered = useGameLine()

  const preloadBookPlies = useCallback(
    async (requestFenHistory: string[], requestReplayMoves: ReplayMove[]) => {
      if (!requestReplayMoves.length) {
        setBookPlies([])
        return
      }
      const key = openingKey(requestFenHistory)
      if (key === bookReadFor && useAppStore.getState().bookPlies.length) return

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
      if (!result.hadErrors) bookReadFor = key
      // An unchanged answer is not set again: a new array re-grades every move.
      if (!samePlies(useAppStore.getState().bookPlies, result.plies)) setBookPlies(result.plies)
      if (result.hadErrors) {
        console.warn(
          '[chessgod] Book moves partially loaded; the theory API returned errors for some positions.',
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

      if (requestFenHistory.length > 1) {
        // The review runs on its own pool of engines, so switching the engine
        // on is all it needs. Starting a board search first (two threads at
        // the interactive depth) only had the review stop it a moment later;
        // with the switch on, the board's own auto-analysis takes it from here.
        const store = useEngineStore.getState()
        if (!store.enabled) useEngineStore.setState({ enabled: true, error: null })
        // Explicit depth, not the interactive selector: see GAME_REVIEW_DEPTH.
        await store.queueReplayAnalysis(requestFenHistory, { depth })
      } else {
        await analyzeBoard()
      }

      void preloadBookPlies(requestFenHistory, requestReplayMoves).catch((err) => {
        console.warn('[chessgod] Failed to load book moves:', err)
      })
    },
    [preloadBookPlies, setAnalysisRequested],
  )

  return { analyzeLine, canAnalyze: rendered.fenHistory.length > 1 }
}
