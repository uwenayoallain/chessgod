import { create } from 'zustand'

import { needsEngineAnalysis } from '@/lib/analysis/analysis-cache'
import { StockfishEngine } from '@/lib/stockfish/engine'
import { isLegalEngineLine, isLegalEngineMove } from '@/lib/stockfish/legal-analysis'
import type { UCIInfo } from '@/lib/stockfish/uci'
import { useAppStore } from '@/store/app-store'

const DEFAULT_DEPTH = 22
const FOREGROUND_MULTI_PV = 3
const BACKGROUND_MULTI_PV = 1
const DEFAULT_HASH = 128
const ANALYZE_DEBOUNCE_MS = 80

type AnalyzeOptions = {
  force?: boolean
  depth?: number
  priority?: 'high' | 'normal'
  multiPV?: number
}

export type CachedEngineAnalysis = {
  bestMove: string | null
  depth: number
  lines: UCIInfo[]
}

type QueueItem = { fen: string; depth: number; multiPV: number }

type EngineState = {
  enabled: boolean
  isReady: boolean
  isAnalyzing: boolean
  isLoadingNnue: boolean
  hasAttempted: boolean
  lines: UCIInfo[]
  bestMove: string | null
  currentDepth: number
  analyzedFen: string | null
  error: string | null
  analysisByFen: Record<string, CachedEngineAnalysis>
  analysisVersion: number
  engineDepth: number
  init: () => Promise<void>
  toggle: () => Promise<void>
  analyzePosition: (fen: string, options?: AnalyzeOptions) => Promise<void>
  queueReplayAnalysis: (fens: string[]) => Promise<void>
  stop: () => void
  setEngineDepth: (depth: number) => void
}

let engine: StockfishEngine | null = null
let analyzeTimer: number | null = null
let queuedAnalyses: QueueItem[] = []
let activeFen: string | null = null
let activeLines: UCIInfo[] = []
let activeDepth = 0
let activeGeneration = 0

function clearAnalyzeTimer() {
  if (analyzeTimer != null) {
    window.clearTimeout(analyzeTimer)
    analyzeTimer = null
  }
}

function getThreadCount() {
  if (typeof navigator === 'undefined') return 1
  const cores = navigator.hardwareConcurrency ?? 2
  return Math.max(1, Math.min(Math.floor(cores / 2), 8))
}

function updateLines(current: UCIInfo[], info: UCIInfo) {
  const next = current.filter((line) => line.multipv !== info.multipv)
  return [...next, info].sort((a, b) => a.multipv - b.multipv)
}

function getCachedAnalysis(fen: string) {
  return useEngineStore.getState().analysisByFen[fen] ?? null
}

function setCurrentFromCache(fen: string) {
  const cachedAnalysis = getCachedAnalysis(fen)
  if (!cachedAnalysis) return false

  useEngineStore.setState({
    analyzedFen: fen,
    bestMove: cachedAnalysis.bestMove,
    currentDepth: cachedAnalysis.depth,
    lines: cachedAnalysis.lines,
  })

  return true
}

function enqueueFen(fen: string, options: AnalyzeOptions = {}) {
  const cachedAnalysis = getCachedAnalysis(fen)
  const requestedDepth = options.depth ?? useEngineStore.getState().engineDepth
  const multiPV = options.multiPV ?? BACKGROUND_MULTI_PV

  if (!needsEngineAnalysis(cachedAnalysis?.depth ?? null, requestedDepth, options.force)) {
    return
  }

  if (activeFen === fen && activeDepth >= requestedDepth) {
    return
  }

  queuedAnalyses = queuedAnalyses.filter((q) => q.fen !== fen)
  const item: QueueItem = { fen, depth: requestedDepth, multiPV }

  if (options.priority === 'high') {
    queuedAnalyses.unshift(item)
    return
  }

  queuedAnalyses.push(item)
}

async function processQueue(interrupt = false) {
  const state = useEngineStore.getState()

  if (!state.enabled || !queuedAnalyses.length) {
    return
  }

  if (activeFen) {
    if (!interrupt) return
    engine?.stop()
    if (activeFen && activeLines.length) {
      const partialFen = activeFen
      useEngineStore.setState((s) => ({
        analysisByFen: {
          ...s.analysisByFen,
          [partialFen]: {
            bestMove: activeLines[0]?.pv[0] || null,
            depth: activeDepth,
            lines: activeLines,
          },
        },
        analysisVersion: s.analysisVersion + 1,
      }))
    }
    activeFen = null
    activeLines = []
    activeDepth = 0
    activeGeneration += 1
  }

  await state.init()

  const nextItem = queuedAnalyses.shift()
  if (!nextItem) return

  activeGeneration += 1
  activeFen = nextItem.fen
  activeLines = []
  activeDepth = 0

  if (useAppStore.getState().currentFen === nextItem.fen) {
    useEngineStore.setState({
      analyzedFen: nextItem.fen,
      bestMove: null,
      currentDepth: 0,
      error: null,
      hasAttempted: true,
      isAnalyzing: true,
      lines: [],
    })
  }

  ensureEngine().analyze(nextItem.fen, {
    depth: nextItem.depth,
    force: true,
    multiPV: nextItem.multiPV,
  })
}

function ensureEngine() {
  if (engine) return engine

  engine = new StockfishEngine({
    onBestMove: (bestMove) => {
      if (!activeFen) return
      if (bestMove && !isLegalEngineMove(activeFen, bestMove)) {
        return
      }
      if (activeDepth === 0 && activeLines.length === 0) {
        activeFen = null
        void processQueue()
        return
      }

      const completedFen = activeFen
      const existingAnalysis = useEngineStore.getState().analysisByFen[completedFen]
      const completedAnalysis: CachedEngineAnalysis = {
        bestMove: bestMove || activeLines[0]?.pv[0] || null,
        depth: Math.max(existingAnalysis?.depth ?? 0, activeDepth),
        lines: activeLines,
      }

      useEngineStore.setState((s) => ({
        analysisByFen: {
          ...s.analysisByFen,
          [completedFen]: completedAnalysis,
        },
        analysisVersion: s.analysisVersion + 1,
        ...(useAppStore.getState().currentFen === completedFen
          ? {
              analyzedFen: completedFen,
              bestMove: completedAnalysis.bestMove,
              currentDepth: activeDepth,
              isAnalyzing: false,
              lines: activeLines,
            }
          : {}),
      }))

      activeFen = null
      activeLines = []
      activeDepth = 0
      void processQueue()
    },
    onError: (error) => {
      useEngineStore.setState({
        error,
        isLoadingNnue: false,
        ...(useAppStore.getState().currentFen === activeFen ? { isAnalyzing: false } : {}),
      })
      activeFen = null
      activeLines = []
      activeDepth = 0
      void processQueue()
    },
    onInfo: (info) => {
      if (!activeFen) return
      if (!isLegalEngineLine(activeFen, info)) return

      activeLines = updateLines(activeLines, info)
      activeDepth = Math.max(activeDepth, info.depth)

      if (useAppStore.getState().currentFen === activeFen) {
        useEngineStore.setState({
          analyzedFen: activeFen,
          currentDepth: activeDepth,
          lines: activeLines,
        })
      }
    },
    onReady: () => {
      useEngineStore.setState({ isLoadingNnue: false, isReady: true })
    },
    onStatus: (status) => {
      if (status === 'initializing') {
        useEngineStore.setState({ error: null, hasAttempted: true, isLoadingNnue: false, isReady: false })
        return
      }
      if (status === 'nnue-loading') {
        useEngineStore.setState({ hasAttempted: true, isLoadingNnue: true })
        return
      }
      if (status === 'nnue-loaded') {
        useEngineStore.setState({ isLoadingNnue: false })
      }
    },
  })

  return engine
}

export const useEngineStore = create<EngineState>((set, get) => ({
  analyzedFen: null,
  analysisByFen: {},
  analysisVersion: 0,
  bestMove: null,
  currentDepth: 0,
  enabled: true,
  engineDepth: DEFAULT_DEPTH,
  error: null,
  hasAttempted: false,
  isAnalyzing: false,
  isLoadingNnue: false,
  isReady: false,
  lines: [],
  init: async () => {
    const currentEngine = ensureEngine()
    await currentEngine.init({ hash: DEFAULT_HASH, threads: getThreadCount() })
  },
  queueReplayAnalysis: async (fens) => {
    queuedAnalyses = []
    activeFen = null
    activeLines = []
    activeDepth = 0
    activeGeneration += 1

    set({ lines: [], bestMove: null, currentDepth: 0, analyzedFen: null, isAnalyzing: true })

    const uniqueFens = Array.from(new Set(fens))
    for (const fen of uniqueFens) {
      enqueueFen(fen, { depth: get().engineDepth, multiPV: BACKGROUND_MULTI_PV })
    }
    await processQueue()
  },
  stop: () => {
    clearAnalyzeTimer()
    engine?.stop()
    queuedAnalyses = []
    activeFen = null
    activeLines = []
    activeDepth = 0
    set({ isAnalyzing: false })
  },
  toggle: async () => {
    if (get().enabled) {
      clearAnalyzeTimer()
      engine?.stop()
      queuedAnalyses = []
      activeFen = null
      activeLines = []
      activeDepth = 0
      set({ analyzedFen: null, bestMove: null, currentDepth: 0, enabled: false, error: null, isAnalyzing: false, lines: [] })
      return
    }
    set({ enabled: true, error: null })
    await get().init()
    await get().analyzePosition(useAppStore.getState().currentFen, { force: true, priority: 'high' })
  },
  setEngineDepth: (depth) => {
    set({ engineDepth: depth })
    if (get().enabled) {
      void get().analyzePosition(useAppStore.getState().currentFen, { force: true, priority: 'high' })
    }
  },
  analyzePosition: async (fen, options = {}) => {
    clearAnalyzeTimer()
    if (!get().enabled) return

    const requestedDepth = options.depth ?? get().engineDepth
    const cachedAnalysis = getCachedAnalysis(fen)
    if (cachedAnalysis) {
      setCurrentFromCache(fen)
      if (!needsEngineAnalysis(cachedAnalysis.depth, requestedDepth, options.force)) {
        set({ isAnalyzing: false })
        return
      }
    }

    if (!cachedAnalysis) {
      set({ analyzedFen: fen, bestMove: null, currentDepth: 0, error: null, hasAttempted: true, isAnalyzing: true, lines: [] })
    } else {
      set({ hasAttempted: true, isAnalyzing: true, error: null })
    }

    analyzeTimer = window.setTimeout(() => {
      const prio = options.priority ?? 'high'
      enqueueFen(fen, { ...options, depth: requestedDepth, priority: prio, multiPV: FOREGROUND_MULTI_PV })
      void processQueue(prio === 'high')
    }, ANALYZE_DEBOUNCE_MS)
  },
}))
