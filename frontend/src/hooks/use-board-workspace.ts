import { useEffect, useMemo, useRef, useState } from 'react'

import { prefetchBookPlies } from '@/lib/analysis/book-moves'
import { api } from '@/lib/api'
import { useTrainingLine, type WorkspaceGame } from '@/hooks/use-workspace-data'
import { useEngineStore } from '@/store/engine-store'
import { STARTING_FEN, useAppStore, type ReplayMove } from '@/store/app-store'
import type { PersistedEngineAnalysis } from '@/store/engine-store'
import { parsePgnToReplay } from '@/lib/chess-utils'

export type OpeningSelection = {
  eco: string | null
  openingName: string
}

export type MistakeReviewSelection = {
  game: WorkspaceGame
  mistakePly: number
}

export function useBoardWorkspace({
  username,
  color,
  timeClass,
}: {
  username: string | null
  color: 'white' | 'black' | 'both'
  timeClass: string | null
}) {
  const currentFen = useAppStore((state) => state.currentFen)
  const loadReplay = useAppStore((state) => state.loadReplay)
  const clearLoadedLine = useAppStore((state) => state.clearLoadedLine)
  const keepUserOnBottom = useAppStore((state) => state.keepUserOnBottom)
  const alignBoardToUserColor = useAppStore((state) => state.alignBoardToUserColor)
  const [selectedGameId, setSelectedGameId] = useState<number | null>(null)
  const [selectedOpening, setSelectedOpening] = useState<OpeningSelection | null>(null)
  const [activeGame, setActiveGame] = useState<WorkspaceGame | null>(null)
  const [activeMistakePly, setActiveMistakePly] = useState<number | null>(null)
  const bookPrefetchGeneration = useRef(0)

  function preloadReplayInsights(replay: ReplayMove[], initialBookPlies: number[] = []) {
    useAppStore.getState().setBookPlies(initialBookPlies)
    bookPrefetchGeneration.current += 1
    const generation = bookPrefetchGeneration.current
    const fenHistory = [STARTING_FEN, ...replay.map((move) => move.fen)]
    const uniqueFens = [...new Set(fenHistory)]
    void (async () => {
      try {
        // Long games exceed practical URL limits. Bounded batches also let
        // switching games abandon stale work before it starts another search.
        for (let start = 0; start < uniqueFens.length; start += 50) {
          if (generation !== bookPrefetchGeneration.current) return
          const response = await api.get<Record<string, PersistedEngineAnalysis>>(
            '/api/analysis/evaluations',
            { params: { fens: uniqueFens.slice(start, start + 50).join(','), min_depth: 22 } },
          )
          useEngineStore.getState().hydrateAnalysisCache(response.data)
        }
      } catch (error) {
        console.warn('[chessgod] Saved analysis could not be loaded; using browser analysis', error)
      } finally {
        if (generation === bookPrefetchGeneration.current) {
          void useEngineStore.getState().queueReplayAnalysis(uniqueFens, { depth: 22 })
        }
      }
    })()
    void prefetchBookPlies({
      fenHistory,
      fetchTheoryCompare: async (fen) => {
        try {
          const response = await api.get<{
            master_moves: Array<{ san: string; uci?: string | null }>
          }>('/api/theory/compare', {
            params: { fen },
          })
          return response.data
        } catch {
          return null
        }
      },
      replayMoves: replay,
    })
      .then((result) => {
        if (generation !== bookPrefetchGeneration.current) return
        useAppStore
          .getState()
          .setBookPlies(
            Array.from(new Set([...initialBookPlies, ...result.plies])).sort((a, b) => a - b),
          )
        if (result.hadErrors) {
          console.warn(
            '[chessgod] Book moves partially loaded — theory API returned errors for some positions.',
          )
        }
      })
      .catch((err) => {
        console.warn('[chessgod] Failed to load book moves:', err)
      })
  }

  const trainingLine = useTrainingLine(
    username,
    selectedOpening?.openingName ?? null,
    selectedOpening?.eco ?? null,
    color,
    timeClass,
    Boolean(selectedOpening),
  )

  useEffect(() => {
    if (!selectedOpening || !trainingLine.data?.moves.length) return

    const replay: ReplayMove[] = trainingLine.data.moves.map((m) => ({
      ply: m.ply,
      san: m.san,
      uci: m.uci,
      fen: m.resulting_fen,
    }))

    // Land on the end of the line: the position that defines the opening, with
    // its last move highlighted. Landing on ply 0 left the board visibly
    // unchanged, which read as the click not working; stepping back through
    // the line is one key away.
    loadReplay(replay, replay.length)
    preloadReplayInsights(
      replay,
      replay.map((move) => move.ply),
    )
    setActiveGame(null)
    setActiveMistakePly(null)
    setSelectedGameId(null)
  }, [loadReplay, selectedOpening, trainingLine.data])

  useEffect(() => {
    if (!keepUserOnBottom || !activeGame) return
    alignBoardToUserColor(activeGame.user_color)
  }, [activeGame, alignBoardToUserColor, keepUserOnBottom])

  const gameFilters = useMemo(
    () => ({
      openingName: null,
      eco: null,
      fen: currentFen !== STARTING_FEN ? currentFen : null,
    }),
    [currentFen],
  )

  function loadGame(game: WorkspaceGame) {
    if (!game.pgn) return
    useAppStore.getState().setIsLoadingGame(true)
    const replay = parsePgnToReplay(game.pgn)
    loadReplay(replay)
    preloadReplayInsights(replay)
    setSelectedGameId(game.id)
    setActiveGame(game)
    setActiveMistakePly(null)
    setSelectedOpening(null)
    useAppStore.getState().setIsLoadingGame(false)
  }

  function loadOpening(opening: OpeningSelection) {
    setActiveMistakePly(null)
    setSelectedOpening(opening)
  }

  function loadMistakeReview(selection: MistakeReviewSelection) {
    if (!selection.game.pgn) return
    useAppStore.getState().setIsLoadingGame(true)
    const replay = parsePgnToReplay(selection.game.pgn)
    const startIndex = Math.max(0, selection.mistakePly - 1)
    loadReplay(replay, startIndex, 'loaded')
    preloadReplayInsights(replay)
    setSelectedGameId(selection.game.id)
    setActiveGame(selection.game)
    setActiveMistakePly(selection.mistakePly)
    setSelectedOpening(null)
    useAppStore.getState().setIsLoadingGame(false)
  }

  function clearLoadedContext() {
    bookPrefetchGeneration.current += 1
    setSelectedOpening(null)
    setSelectedGameId(null)
    setActiveGame(null)
    setActiveMistakePly(null)
    clearLoadedLine()
  }

  return {
    currentFen,
    selectedGameId,
    selectedOpening,
    activeGame,
    activeMistakePly,
    setSelectedGameId,
    loadGame,
    loadOpening,
    loadMistakeReview,
    clearLoadedContext,
    gameFilters,
    trainingLine,
  }
}
