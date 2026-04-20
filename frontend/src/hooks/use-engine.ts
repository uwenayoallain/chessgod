import { useEffect } from 'react'

import { getEngineStatusMessage } from '@/lib/engine-status'
import { selectCurrentEngineView } from '@/lib/engine-view'
import { useEngineStore } from '@/store/engine-store'
import { useAppStore } from '@/store/app-store'

export function useEngine() {
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
  const analysisByFen = useEngineStore((state) => state.analysisByFen)
  const init = useEngineStore((state) => state.init)
  const analyzePosition = useEngineStore((state) => state.analyzePosition)
  const queueReplayAnalysis = useEngineStore((state) => state.queueReplayAnalysis)
  const stop = useEngineStore((state) => state.stop)
  const toggle = useEngineStore((state) => state.toggle)

  useEffect(() => {
    if (!enabled) {
      return
    }

    void init()
  }, [enabled, init])

  useEffect(() => {
    if (!enabled) return
    void analyzePosition(currentFen, { priority: 'high' })
  }, [analyzePosition, currentFen, enabled])

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
    analysisByFen,
    analyze: async (fen = currentFen, force = true) => {
      if (!useEngineStore.getState().enabled) {
        await toggle()
        if (fen !== useAppStore.getState().currentFen) {
          await analyzePosition(fen, { force, priority: 'high' })
        }
        return
      }

      await analyzePosition(fen, { force, priority: 'high' })
    },
    queueReplayAnalysis,
    stop,
    toggle,
    error,
    hasAttempted,
    statusMessage: getEngineStatusMessage({
      currentDepth: currentView.currentDepth,
      enabled,
      error,
      hasAttempted,
      isAnalyzing,
      isLoadingNnue,
      isReady,
    }),
  }
}
