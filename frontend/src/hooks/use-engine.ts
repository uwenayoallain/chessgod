import { useEffect, useRef } from 'react'

import { shouldAutoAnalyze } from '@/lib/analysis/auto-analysis'

import { getEngineStatusMessage } from '@/lib/engine-status'
import { selectCurrentEngineView } from '@/lib/engine-view'
import { useEngineStore } from '@/store/engine-store'
import { useAppStore } from '@/store/app-store'

/**
 * The board's automatic analysis, and nothing else: searching each position
 * the board lands on while `autoAnalyze` holds, stopping when it stops holding
 * or the tab is hidden. Subscribes to the position and the switch only, so the
 * caller does not re-render on every line the engine reports.
 */
export function useAutoAnalysis(autoAnalyze: boolean) {
  const currentFen = useAppStore((state) => state.currentFen)
  const enabled = useEngineStore((state) => state.enabled)
  const analyzePosition = useEngineStore((state) => state.analyzePosition)

  // No start-up effect: the engine starts on the first search (the queue and
  // `playMove` both start it) and is released after five minutes with nothing
  // to do. Starting it on mount held ~1GB from page load, Review tab included.

  useEffect(() => {
    if (!enabled || !autoAnalyze) return
    // The board sits at the starting position until a game or line is loaded,
    // so without this simply opening the app began a full-depth search of the
    // opening — a position whose evaluation is already known and which belongs
    // to no decision anyone made. Asking for it explicitly still works.
    if (!shouldAutoAnalyze(currentFen)) return
    void analyzePosition(currentFen, { priority: 'high' })
  }, [analyzePosition, autoAnalyze, currentFen, enabled])

  // Leaving every surface that reads the board (the Library, the Review tab, a
  // collapsed sidebar, a drill being solved) stops the board search there and
  // then: a depth-30 search otherwise ran on for up to its 90s timeout with
  // nothing on screen showing it. Only a change from on to off counts, so the
  // callers that never auto-analyse (the engine bar, the board) never stop it.
  const wasAutoAnalyzing = useRef(autoAnalyze)
  useEffect(() => {
    if (wasAutoAnalyzing.current && !autoAnalyze) useEngineStore.getState().stopInteractive()
    wasAutoAnalyzing.current = autoAnalyze
  }, [autoAnalyze])

  // Stop burning the user's cores searching a position they can't see. When the
  // tab is hidden we halt the search; when it comes back (and this view drives
  // analysis) we re-analyze the current position. Only the auto-analyze caller
  // owns this so the read-only engine-bar/board callers don't fight over it.
  useEffect(() => {
    if (!autoAnalyze || typeof document === 'undefined') return
    function onVisibilityChange() {
      if (document.hidden) {
        // The board search only. `stop()` also aborted a game review, which
        // then never restarted: the player came back to a review stopped
        // halfway. A review is finite work they asked for, so it finishes.
        useEngineStore.getState().stopInteractive()
      } else if (useEngineStore.getState().enabled) {
        const fen = useAppStore.getState().currentFen
        if (shouldAutoAnalyze(fen)) void analyzePosition(fen, { priority: 'high' })
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [analyzePosition, autoAnalyze])
}

/** The engine's lines for the board position, for the one component that shows them. */
export function useEngineView() {
  const currentFen = useAppStore((state) => state.currentFen)
  const isAnalyzing = useEngineStore((state) => state.isAnalyzing)
  const lines = useEngineStore((state) => state.lines)
  const bestMove = useEngineStore((state) => state.bestMove)
  const currentDepth = useEngineStore((state) => state.currentDepth)
  const analyzedFen = useEngineStore((state) => state.analyzedFen)
  const analysisByFen = useEngineStore((state) => state.analysisByFen)
  const view = selectCurrentEngineView({
    analysisByFen,
    analyzedFen,
    bestMove,
    currentDepth,
    currentFen,
    lines,
  })
  return { isAnalyzing, lines: view.lines }
}

/** Analyse a position now, switching the engine on first if it is off. */
export async function analyzeBoard(
  fen = useAppStore.getState().currentFen,
  force = true,
  options: { deep?: boolean; stable?: boolean } = {},
) {
  const store = useEngineStore.getState()
  if (!store.enabled) {
    await store.toggle()
    if (fen !== useAppStore.getState().currentFen) {
      await store.analyzePosition(fen, { force, priority: 'high', ...options })
    }
    return
  }
  await store.analyzePosition(fen, { force, priority: 'high', ...options })
}

export function useEngine({ autoAnalyze = true }: { autoAnalyze?: boolean } = {}) {
  const currentFen = useAppStore((state) => state.currentFen)
  const enabled = useEngineStore((state) => state.enabled)
  const isReady = useEngineStore((state) => state.isReady)
  const isAnalyzing = useEngineStore((state) => state.isAnalyzing)
  const isLoadingNnue = useEngineStore((state) => state.isLoadingNnue)
  const lines = useEngineStore((state) => state.lines)
  const bestMove = useEngineStore((state) => state.bestMove)
  const currentDepth = useEngineStore((state) => state.currentDepth)
  const analyzedFen = useEngineStore((state) => state.analyzedFen)
  const error = useEngineStore((state) => state.error)
  const hasAttempted = useEngineStore((state) => state.hasAttempted)
  const activeMode = useEngineStore((state) => state.activeMode)
  const analysisByFen = useEngineStore((state) => state.analysisByFen)
  const highPerformance = useEngineStore((state) => state.highPerformance)
  const queueReplayAnalysis = useEngineStore((state) => state.queueReplayAnalysis)
  const stop = useEngineStore((state) => state.stop)
  const toggle = useEngineStore((state) => state.toggle)
  const setHighPerformance = useEngineStore((state) => state.setHighPerformance)

  useAutoAnalysis(autoAnalyze)

  const currentView = selectCurrentEngineView({
    analysisByFen,
    analyzedFen,
    bestMove,
    currentDepth,
    currentFen,
    lines,
  })

  return {
    enabled,
    isReady,
    isAnalyzing,
    isLoadingNnue,
    lines: currentView.lines,
    bestMove: currentView.bestMove,
    currentDepth: currentView.currentDepth,
    activeMode,
    analysisByFen,
    analyze: analyzeBoard,
    queueReplayAnalysis,
    stop,
    toggle,
    highPerformance,
    setHighPerformance,
    error,
    hasAttempted,
    statusMessage: getEngineStatusMessage({
      currentDepth: currentView.currentDepth,
      activeMode,
      enabled,
      error,
      hasAttempted,
      isAnalyzing,
      isLoadingNnue,
      isReady,
    }),
  }
}
