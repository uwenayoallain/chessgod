import { useEffect } from 'react'

import { shouldAutoAnalyze } from '@/lib/analysis/auto-analysis'

import { getEngineStatusMessage } from '@/lib/engine-status'
import { selectCurrentEngineView } from '@/lib/engine-view'
import { useEngineStore } from '@/store/engine-store'
import { useAppStore } from '@/store/app-store'

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
  const init = useEngineStore((state) => state.init)
  const analyzePosition = useEngineStore((state) => state.analyzePosition)
  const queueReplayAnalysis = useEngineStore((state) => state.queueReplayAnalysis)
  const stop = useEngineStore((state) => state.stop)
  const toggle = useEngineStore((state) => state.toggle)
  const setHighPerformance = useEngineStore((state) => state.setHighPerformance)

  useEffect(() => {
    if (!enabled) {
      return
    }

    void init()
  }, [enabled, init])

  useEffect(() => {
    if (!enabled || !autoAnalyze) return
    // The board sits at the starting position until a game or line is loaded,
    // so without this simply opening the app began a full-depth search of the
    // opening — a position whose evaluation is already known and which belongs
    // to no decision anyone made. Asking for it explicitly still works.
    if (!shouldAutoAnalyze(currentFen)) return
    void analyzePosition(currentFen, { priority: 'high' })
  }, [analyzePosition, autoAnalyze, currentFen, enabled])

  // Stop burning the user's cores searching a position they can't see. When the
  // tab is hidden we halt the search; when it comes back (and this view drives
  // analysis) we re-analyze the current position. Only the auto-analyze caller
  // owns this so the read-only engine-bar/board callers don't fight over it.
  useEffect(() => {
    if (!autoAnalyze || typeof document === 'undefined') return
    function onVisibilityChange() {
      if (document.hidden) {
        stop()
      } else if (useEngineStore.getState().enabled) {
        const fen = useAppStore.getState().currentFen
        if (shouldAutoAnalyze(fen)) void analyzePosition(fen, { priority: 'high' })
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [analyzePosition, autoAnalyze, stop])

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
    analyze: async (
      fen = currentFen,
      force = true,
      options: { deep?: boolean; stable?: boolean } = {},
    ) => {
      if (!useEngineStore.getState().enabled) {
        await toggle()
        if (fen !== useAppStore.getState().currentFen) {
          await analyzePosition(fen, { force, priority: 'high', ...options })
        }
        return
      }

      await analyzePosition(fen, { force, priority: 'high', ...options })
    },
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
