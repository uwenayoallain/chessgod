import { useEffect, useMemo, useRef, useState } from 'react'

import { prefetchBookPlies } from '@/lib/analysis/book-moves'
import { api } from '@/lib/api'
import { useTrainingLine, type WorkspaceGame } from '@/hooks/use-workspace-data'
import { useEngineStore } from '@/store/engine-store'
import { STARTING_FEN, useAppStore, type ReplayMove } from '@/store/app-store'
import { parsePgnToReplay } from '@/lib/chess-utils'

export type OpeningSelection = {
  eco: string | null
  openingName: string
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
  const bookPrefetchGeneration = useRef(0)

  function preloadReplayInsights(replay: ReplayMove[], initialBookPlies: number[] = []) {
    const fenHistory = [STARTING_FEN, ...replay.map((move) => move.fen)]
    void useEngineStore.getState().queueReplayAnalysis(fenHistory)
    useAppStore.getState().setBookPlies(initialBookPlies)
    bookPrefetchGeneration.current += 1
    const generation = bookPrefetchGeneration.current
    void prefetchBookPlies({
      fenHistory,
      fetchTheoryCompare: async (fen) => {
        try {
          const response = await api.get<{ master_moves: Array<{ san: string; uci?: string | null }> }>('/api/theory/compare', {
            params: { fen },
          })
          return response.data
        } catch {
          return null
        }
      },
      replayMoves: replay,
    }).then((result) => {
      if (generation !== bookPrefetchGeneration.current) return
      useAppStore.getState().setBookPlies(Array.from(new Set([...initialBookPlies, ...result.plies])).sort((a, b) => a - b))
      if (result.hadErrors) {
        console.warn('[chessgod] Book moves partially loaded — theory API returned errors for some positions.')
      }
    }).catch((err) => {
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

    loadReplay(replay)
    preloadReplayInsights(replay, replay.map((move) => move.ply))
    setActiveGame(null)
    setSelectedGameId(null)
  }, [loadReplay, selectedOpening, trainingLine.data])

  useEffect(() => {
    if (!keepUserOnBottom || !activeGame) return
    alignBoardToUserColor(activeGame.user_color)
  }, [activeGame, alignBoardToUserColor, keepUserOnBottom])

  const gameFilters = useMemo(
    () => ({
      openingName: selectedOpening?.openingName ?? null,
      eco: selectedOpening?.eco ?? null,
      fen: selectedOpening ? null : currentFen !== STARTING_FEN ? currentFen : null,
    }),
    [currentFen, selectedOpening],
  )

  function loadGame(game: WorkspaceGame) {
    if (!game.pgn) return
    useAppStore.getState().setIsLoadingGame(true)
    const replay = parsePgnToReplay(game.pgn)
    loadReplay(replay)
    preloadReplayInsights(replay)
    setSelectedGameId(game.id)
    setActiveGame(game)
    setSelectedOpening(null)
    useAppStore.getState().setIsLoadingGame(false)
  }

  function loadOpening(opening: OpeningSelection) {
    setSelectedOpening(opening)
  }

  function clearLoadedContext() {
    bookPrefetchGeneration.current += 1
    setSelectedOpening(null)
    setSelectedGameId(null)
    setActiveGame(null)
    clearLoadedLine()
  }

  return {
    currentFen,
    selectedGameId,
    selectedOpening,
    activeGame,
    setSelectedGameId,
    loadGame,
    loadOpening,
    clearLoadedContext,
    gameFilters,
    trainingLine,
  }
}
