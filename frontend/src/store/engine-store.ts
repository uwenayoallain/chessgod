import { create } from 'zustand'

import { mergeEngineAnalysis, needsEngineAnalysis } from '@/lib/analysis/analysis-cache'
import {
  chooseEngineMode,
  completeReplayJob,
  enqueueAnalysisJob,
  handleReplayTimeout,
  type AnalysisJob,
  type AnalysisMode,
} from '@/lib/stockfish/analysis-policy'
import { StockfishEngine } from '@/lib/stockfish/engine'
import { reviewPoolSize, runReviewPool } from '@/lib/stockfish/review-pool'
import {
  getLegalMoveCount,
  getTerminalOutcome,
  isLegalEngineLine,
  isLegalEngineMove,
} from '@/lib/stockfish/legal-analysis'
import type { UCIInfo } from '@/lib/stockfish/uci'
import { STOCKFISH_ENGINE_ID } from '@/lib/stockfish/version'
import { getTelemetryNowMs, reportFrontendEvent } from '@/lib/telemetry'
import { useAppStore } from '@/store/app-store'

// Interactive "quick" analysis is capped lower for responsiveness; stable,
// deep, and replay passes target this higher browser-computed depth.
const DEFAULT_DEPTH = 30
const ANALYZE_DEBOUNCE_MS = 60
const STABLE_ANALYZE_DELAY_MS = 650
// Depth 30 with the full net needs more headroom per position than depth 24
// did on the smallnet.
const POSITION_TIMEOUT_MS = 90_000
const MAX_RETRIES = 2
// Measured in Chrome on this build (8 middlegame positions, depth 20): one
// thread 1.72s a position, two 1.08s, seven 2.41s. Past two, Stockfish's
// shared-tree search in wasm loses more to synchronisation than it gains, so
// "cores − 1" made every analysis in the app slower than a single thread.
const MAX_ENGINE_THREADS = 2
// A long imported history can contain tens of thousands of unique boards. Keep
// enough for a complete game and recent replay work without letting a browser
// tab grow forever as background analysis progresses.
export const MAX_ANALYSIS_CACHE_ENTRIES = 5_000
type AnalyzeOptions = {
  force?: boolean
  depth?: number
  deep?: boolean
  priority?: 'high' | 'normal'
  stable?: boolean
}

export type CachedEngineAnalysis = {
  bestMove: string | null
  depth: number
  engine?: string
  lines: UCIInfo[]
  persisted?: boolean
}

export type PersistedEngineAnalysis = {
  depth: number
  eval_cp: number | null
  eval_mate: number | null
  best_move_uci: string
  pv_uci: string | null
  multipv_rank: number
  engine?: string
}

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
  activeMode: AnalysisMode | null
  replayQueueActive: boolean
  replayQueueCompleted: number
  replayQueueTotal: number
  replayQueueStartedAt: number | null
  /** What the running replay queue is for, so progress can say so. */
  replayQueueKind: 'game' | 'library' | null
  init: () => Promise<void>
  toggle: () => Promise<void>
  analyzePosition: (fen: string, options?: AnalyzeOptions) => Promise<void>
  hydrateAnalysisCache: (analysisByFen: Record<string, PersistedEngineAnalysis>) => void
  /**
   * Queue a batch of positions for background analysis. Resolves with the
   * number of positions actually enqueued, which is not the number requested:
   * a position already cached at the requested depth, or one that is already
   * checkmate or stalemate, is not work. A caller that polls for more work has
   * to know the difference, or it will ask for the same batch forever.
   */
  queueReplayAnalysis: (
    fens: string[],
    options?: { depth?: number; depthByFen?: Record<string, number>; background?: boolean },
  ) => Promise<number>
  /**
   * Search candidate moves for the sparring opponent. Analysis is paused for
   * the length of the search and resumes afterwards; the lines are never
   * cached or uploaded, because they are cut off at a short horizon on purpose.
   */
  playMove: (fen: string, options: { depth: number; multiPV: number }) => Promise<UCIInfo[] | null>
  stop: () => void
  setEngineDepth: (depth: number) => void
  highPerformance: boolean
  setHighPerformance: (value: boolean) => Promise<void>
}

// navigator.deviceMemory can't see real RAM (Chrome caps it at 8 for
// fingerprinting; Firefox/Safari don't expose it at all), so a 16–32GB machine
// is otherwise stuck on a hash-starved 512MB search. This opt-in lets the user
// say "I have the RAM" and unlocks a 1GB hash. Persisted so the choice sticks.
const HIGH_PERF_STORAGE_KEY = 'chessgod.highPerformance'
const HIGH_PERF_HASH_MB = 1024

function readHighPerformance(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(HIGH_PERF_STORAGE_KEY) === 'true'
}

let engine: StockfishEngine | null = null
let analyzeTimer: number | null = null
let stableAnalyzeTimer: number | null = null
let queuedAnalyses: AnalysisJob[] = []
let activeQueueItem: AnalysisJob | null = null
let activeFen: string | null = null
let activeLines: UCIInfo[] = []
let activeDepth = 0
let activeGeneration = 0
let pendingRafId: number | null = null
let activeStartedAt: number | null = null
let activeLastNps: number | null = null
let positionTimeoutId: number | null = null
// While the sparring opponent is choosing a move it owns the one worker; the
// analysis queue waits rather than stopping that search to start its own.
let botSearchActive = false
// The game review running on its own pool of engines, if any.
let reviewAbort: AbortController | null = null
// Each pool engine keeps a small table: it searches one position at a time.
const REVIEW_HASH_MB = 32

function abortGameReview() {
  reviewAbort?.abort()
  reviewAbort = null
}

/** Merge one pool search into the cache exactly as a queued search would be. */
function recordReviewResult(fen: string, lines: UCIInfo[] | null) {
  const legal = (lines ?? []).filter((line) => isLegalEngineLine(fen, line))
  const top = legal.find((line) => line.multipv === 1)
  useEngineStore.setState((s) => {
    const progress = completeReplayJob({
      completed: s.replayQueueCompleted,
      total: s.replayQueueTotal,
    })
    return {
      replayQueueCompleted: progress.completed,
      ...(top
        ? {
            analysisByFen: trimAnalysisCache(
              {
                ...s.analysisByFen,
                [fen]: mergeEngineAnalysis<CachedEngineAnalysis>(s.analysisByFen[fen], {
                  bestMove: top.pv[0] ?? null,
                  depth: top.depth,
                  engine: STOCKFISH_ENGINE_ID,
                  lines: legal,
                }),
              },
              fen,
            ),
            analysisVersion: s.analysisVersion + 1,
          }
        : {}),
    }
  })
}

/**
 * Review a game's positions side by side on a pool of single-threaded engines.
 * One after another on the main engine, a 75-position review took over eight
 * minutes; see `reviewPoolSize` for why several engines beat more threads.
 */
async function runGameReview(jobs: AnalysisJob[]) {
  abortGameReview()
  const controller = new AbortController()
  reviewAbort = controller
  try {
    await runReviewPool({
      jobs: jobs.map((job) => ({ fen: job.fen, depth: job.depth })),
      size: reviewPoolSize(),
      hash: REVIEW_HASH_MB,
      signal: controller.signal,
      create: () =>
        new StockfishEngine({
          onInfo: () => {},
          onBestMove: () => {},
          onReady: () => {},
          onStatus: () => {},
          onError: (message) => emitEngineEvent('engine_error', { error_message: message }),
        }),
      onResult: (job, lines) => recordReviewResult(job.fen, lines),
    })
  } finally {
    if (reviewAbort === controller) {
      reviewAbort = null
      useEngineStore.setState({
        replayQueueActive: false,
        isAnalyzing: activeFen !== null,
        activeMode: activeQueueItem?.mode ?? null,
      })
    }
  }
}
const retryMap = new Map<string, number>()
// Replay FENs that timed out or exhausted error retries in this page session.
// Skip them in automatic batch fetches so failed work cannot block coverage.
const replayTimedOutFens = new Set<string>()

function deferReplayFen(fen: string) {
  replayTimedOutFens.add(fen)
  if (replayTimedOutFens.size > 512) {
    // Bound memory and request size; old deferrals become eligible again once
    // enough other work has advanced the session.
    const oldest = replayTimedOutFens.values().next().value
    if (oldest) replayTimedOutFens.delete(oldest)
  }
}

export function trimAnalysisCache<T>(cache: Record<string, T>, preserveFen?: string) {
  const keys = Object.keys(cache)
  if (keys.length <= MAX_ANALYSIS_CACHE_ENTRIES) return cache
  const next = { ...cache }
  let remove = keys.length - MAX_ANALYSIS_CACHE_ENTRIES
  for (const key of keys) {
    if (!remove) break
    if (key === preserveFen) continue
    delete next[key]
    remove -= 1
  }
  return next
}

/** Returns true if this FEN timed out during replay analysis this session. */
export function isReplayTimedOutFen(fen: string): boolean {
  return replayTimedOutFens.has(fen)
}

/** Read only when requesting work; timeout state does not need a UI subscription. */
export function getReplayTimedOutFens(): string[] {
  return [...replayTimedOutFens].slice(-512)
}

function emitEngineEvent(
  name: 'analysis_complete' | 'engine_error',
  extra: Record<string, string | number | boolean | null | undefined> = {},
) {
  const duration =
    activeStartedAt != null ? Math.max(0, getTelemetryNowMs() - activeStartedAt) : undefined
  const fenFragment = activeFen ? activeFen.split(' ')[0]?.slice(0, 24) : undefined
  reportFrontendEvent({
    kind: 'engine',
    name,
    severity: name === 'engine_error' ? 'error' : 'info',
    duration_ms: duration,
    meta: {
      depth: activeDepth || null,
      nps: activeLastNps,
      multi_pv: activeQueueItem?.multiPV ?? null,
      mode: activeQueueItem?.mode ?? null,
      queue_depth: queuedAnalyses.length,
      source: activeQueueItem?.source ?? null,
      fen_fragment: fenFragment ?? null,
      ...extra,
    },
  })
}

function clearAnalyzeTimer() {
  if (analyzeTimer != null) {
    window.clearTimeout(analyzeTimer)
    analyzeTimer = null
  }
  if (stableAnalyzeTimer != null) {
    window.clearTimeout(stableAnalyzeTimer)
    stableAnalyzeTimer = null
  }
}

function clearPositionTimeout() {
  if (positionTimeoutId != null) {
    window.clearTimeout(positionTimeoutId)
    positionTimeoutId = null
  }
}

function startPositionTimeout() {
  clearPositionTimeout()
  const generation = activeGeneration
  positionTimeoutId = window.setTimeout(() => {
    if (activeGeneration !== generation || !activeFen) return
    const timedOutFen = activeFen
    const timedOutItem = activeQueueItem
    // A deep look at the board position that runs out of time is not a
    // failure: keep what it reached. It used to report an error and discard
    // everything — six times in one session, each after 90 seconds and at
    // depth 26 — so returning to the position started the search from zero.
    if (timedOutItem?.source === 'interactive' && storableLines(timedOutFen, activeLines).length) {
      engine?.stop()
      completeActiveAnalysis(null)
      return
    }
    emitEngineEvent('engine_error', { error_message: 'position_timeout' })
    engine?.stop()
    if (pendingRafId !== null) {
      cancelAnimationFrame(pendingRafId)
      pendingRafId = null
    }
    if (timedOutItem?.source === 'replay') {
      const attempts = retryMap.get(timedOutFen) ?? 0
      const timeoutPolicy = handleReplayTimeout({
        attempts,
        maxRetries: MAX_RETRIES,
        reachedDepth: activeDepth,
      })
      if (timeoutPolicy.retry) {
        retryMap.set(timedOutFen, attempts + 1)
        queuedAnalyses.push(timedOutItem)
      }
      if (timeoutPolicy.complete) {
        // Record this FEN so future batch fetches skip it rather than
        // re-queuing a position the device can't finish in time.
        deferReplayFen(timedOutFen)
        const timedOutLines = storableLines(timedOutFen, activeLines)
        if (timedOutLines.length) {
          useEngineStore.setState((s) => ({
            analysisByFen: trimAnalysisCache(
              {
                ...s.analysisByFen,
                [timedOutFen]: mergeEngineAnalysis(s.analysisByFen[timedOutFen], {
                  bestMove: timedOutLines[0]?.pv[0] || null,
                  depth: timedOutLines.find((line) => line.multipv === 1)?.depth ?? 0,
                  engine: STOCKFISH_ENGINE_ID,
                  lines: timedOutLines,
                }),
              },
              timedOutFen,
            ),
            analysisVersion: s.analysisVersion + 1,
          }))
        }
        useEngineStore.setState((s) => {
          const progress = completeReplayJob({
            completed: s.replayQueueCompleted,
            total: s.replayQueueTotal,
          })
          return {
            replayQueueCompleted: progress.completed,
            replayQueueActive: progress.active,
            ...(!progress.active ? { activeMode: null, isAnalyzing: false } : {}),
          }
        })
      }
    }
    activeFen = null
    activeQueueItem = null
    activeLines = []
    activeDepth = 0
    activeStartedAt = null
    activeLastNps = null
    activeGeneration += 1
    useEngineStore.setState({ activeMode: null })
    void processQueue()
  }, POSITION_TIMEOUT_MS)
}

export function getEngineThreadCount(hardwareConcurrency?: number) {
  const cores =
    hardwareConcurrency ??
    (typeof navigator === 'undefined' ? 2 : (navigator.hardwareConcurrency ?? 2))
  return Math.min(MAX_ENGINE_THREADS, Math.max(1, cores - 1))
}

function getThreadCount() {
  return getEngineThreadCount()
}

// navigator.deviceMemory is Chrome-only, spec-capped at 8 to prevent
// fingerprinting. Firefox/Safari fall through to the ?? 4 default → 256MB.
function getHashSize(highPerformance = false): number {
  if (highPerformance) return HIGH_PERF_HASH_MB
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4
  if (mem >= 8) return 512
  if (mem >= 4) return 256
  return 128
}

/**
 * The lines fit to store: every move of each PV legal from `fen`. Live info
 * lines are checked on their first move only — replaying every PV with
 * chess.js on every info line cost ~27ms per position stepped to (measured),
 * and the display already stops a PV at its first move that will not play.
 * Nothing reaches the cache, or the server, without the full check here.
 */
function storableLines(fen: string, lines: UCIInfo[]) {
  return lines.filter((line) => isLegalEngineLine(fen, line))
}

function updateLines(current: UCIInfo[], info: UCIInfo) {
  const next = current.filter((line) => line.multipv !== info.multipv)
  return [...next, info].sort((a, b) => a.multipv - b.multipv)
}

function whiteScoreToEnginePerspective(
  fen: string,
  evalCp: number | null,
  evalMate: number | null,
): UCIInfo['score'] {
  const value = evalMate ?? evalCp ?? 0
  const perspectiveValue = fen.split(' ')[1] === 'b' ? value * -1 : value
  return evalMate != null
    ? { type: 'mate', value: perspectiveValue }
    : { type: 'cp', value: perspectiveValue }
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
  if (getTerminalOutcome(fen)) return false
  const cachedAnalysis = getCachedAnalysis(fen)
  const requestedDepth = options.depth ?? useEngineStore.getState().engineDepth
  const source = options.priority === 'normal' ? 'replay' : 'interactive'
  const mode = chooseEngineMode({
    requestedDepth,
    source,
    stable: options.stable ?? source === 'replay',
    deep: options.deep,
  })
  mode.multiPV = Math.min(mode.multiPV, getLegalMoveCount(fen) ?? mode.multiPV)

  const availableMultiPV =
    cachedAnalysis?.lines.filter((line) => line.multipv <= mode.multiPV && line.depth >= mode.depth)
      .length ?? 0
  if (
    !needsEngineAnalysis(
      cachedAnalysis?.depth ?? null,
      mode.depth,
      options.force,
      availableMultiPV,
      mode.multiPV,
    )
  ) {
    return false
  }

  if (
    activeFen === fen &&
    (activeQueueItem?.depth ?? 0) >= mode.depth &&
    (activeQueueItem?.multiPV ?? 1) >= mode.multiPV
  ) {
    return false
  }

  const item: AnalysisJob = {
    fen,
    depth: mode.depth,
    mode: mode.mode,
    multiPV: mode.multiPV,
    source,
  }

  queuedAnalyses = enqueueAnalysisJob(queuedAnalyses, item)
  return true
}

function completeActiveAnalysis(bestMove: string | null, provider = STOCKFISH_ENGINE_ID) {
  if (!activeFen) return
  if (bestMove && !isLegalEngineMove(activeFen, bestMove)) return

  clearPositionTimeout()
  if (activeDepth === 0 && activeLines.length === 0) {
    if (activeQueueItem?.source === 'replay') {
      useEngineStore.setState((s) => {
        const progress = completeReplayJob({
          completed: s.replayQueueCompleted,
          total: s.replayQueueTotal,
        })
        return {
          replayQueueCompleted: progress.completed,
          replayQueueActive: progress.active,
          ...(progress.active ? {} : { activeMode: null, isAnalyzing: false }),
        }
      })
    }
    activeFen = null
    activeQueueItem = null
    activeStartedAt = null
    activeLastNps = null
    useEngineStore.setState({ activeMode: null })
    void processQueue()
    return
  }

  const completedFen = activeFen
  const completedLines = storableLines(completedFen, activeLines)
  const existingAnalysis = useEngineStore.getState().analysisByFen[completedFen]
  const completedAnalysis = mergeEngineAnalysis<CachedEngineAnalysis>(existingAnalysis, {
    bestMove: completedLines[0]?.pv[0] || bestMove || null,
    depth: completedLines.find((line) => line.multipv === 1)?.depth ?? 0,
    engine: provider,
    lines: completedLines,
  })

  const completedItem = activeQueueItem
  emitEngineEvent('analysis_complete', { provider })

  useEngineStore.setState((s) => {
    const replayCompleted =
      completedItem?.source === 'replay'
        ? completeReplayJob({ completed: s.replayQueueCompleted, total: s.replayQueueTotal })
            .completed
        : s.replayQueueCompleted
    const replayActive =
      completedItem?.source === 'replay'
        ? replayCompleted < s.replayQueueTotal
        : s.replayQueueActive

    return {
      analysisByFen: trimAnalysisCache(
        {
          ...s.analysisByFen,
          [completedFen]: completedAnalysis,
        },
        completedFen,
      ),
      analysisVersion: s.analysisVersion + 1,
      replayQueueCompleted: replayCompleted,
      replayQueueActive: replayActive,
      ...(useAppStore.getState().currentFen === completedFen
        ? {
            analyzedFen: completedFen,
            bestMove: completedAnalysis.bestMove,
            currentDepth: completedAnalysis.depth,
            isAnalyzing: replayActive,
            lines: completedAnalysis.lines,
            activeMode: replayActive ? s.activeMode : null,
          }
        : !replayActive
          ? { activeMode: null, isAnalyzing: false }
          : {}),
    }
  })

  if (pendingRafId !== null) {
    cancelAnimationFrame(pendingRafId)
    pendingRafId = null
  }
  activeFen = null
  activeQueueItem = null
  activeLines = []
  activeDepth = 0
  activeStartedAt = null
  activeLastNps = null
  useEngineStore.setState({ activeMode: null })
  void processQueue()
}

async function processQueue(interrupt = false) {
  const state = useEngineStore.getState()

  if (botSearchActive || !state.enabled || !queuedAnalyses.length) {
    return
  }

  if (activeFen) {
    if (!interrupt) return
    engine?.stop()
    if (pendingRafId !== null) {
      cancelAnimationFrame(pendingRafId)
      pendingRafId = null
    }
    const partialFen = activeFen
    const partialLines = partialFen ? storableLines(partialFen, activeLines) : []
    if (partialFen && partialLines.length) {
      useEngineStore.setState((s) => ({
        analysisByFen: trimAnalysisCache(
          {
            ...s.analysisByFen,
            [partialFen]: mergeEngineAnalysis(s.analysisByFen[partialFen], {
              bestMove: partialLines[0]?.pv[0] || null,
              depth: partialLines.find((line) => line.multipv === 1)?.depth ?? 0,
              engine: STOCKFISH_ENGINE_ID,
              lines: partialLines,
            }),
          },
          partialFen,
        ),
        analysisVersion: s.analysisVersion + 1,
      }))
    }
    if (activeQueueItem?.source === 'replay') {
      useEngineStore.setState((s) => {
        const progress = completeReplayJob({
          completed: s.replayQueueCompleted,
          total: s.replayQueueTotal,
        })
        return {
          replayQueueCompleted: progress.completed,
          replayQueueActive: progress.active,
        }
      })
    }
    clearPositionTimeout()
    activeFen = null
    activeQueueItem = null
    activeLines = []
    activeDepth = 0
    activeStartedAt = null
    activeLastNps = null
    useEngineStore.setState({ activeMode: null })
    activeGeneration += 1
  }

  const nextItem = queuedAnalyses.shift()
  if (!nextItem) return

  activeGeneration += 1
  activeQueueItem = nextItem
  activeFen = nextItem.fen
  activeLines = []
  activeDepth = 0
  activeStartedAt = getTelemetryNowMs()
  activeLastNps = null

  if (useAppStore.getState().currentFen === nextItem.fen) {
    useEngineStore.setState({
      analyzedFen: nextItem.fen,
      bestMove: null,
      currentDepth: 0,
      error: null,
      hasAttempted: true,
      isAnalyzing: true,
      lines: [],
      activeMode: nextItem.mode,
    })
  } else {
    useEngineStore.setState({ activeMode: nextItem.mode, isAnalyzing: true })
  }

  const generation = activeGeneration
  await state.init()
  if (activeGeneration !== generation || activeFen !== nextItem.fen) return

  ensureEngine().analyze(nextItem.fen, {
    depth: nextItem.depth,
    force: true,
    multiPV: nextItem.multiPV,
  })
  startPositionTimeout()
}

function ensureEngine() {
  if (engine) return engine

  engine = new StockfishEngine({
    onBestMove: (bestMove) => completeActiveAnalysis(bestMove),
    onError: (error) => {
      clearPositionTimeout()
      emitEngineEvent('engine_error', { error_message: error })
      const errorFen = activeFen
      const errorItem = activeQueueItem
      const replayState = useEngineStore.getState()

      // Retry replay jobs that failed, otherwise count as completed
      let replayCompleted = replayState.replayQueueCompleted
      let replayActive = replayState.replayQueueActive
      if (errorItem?.source === 'replay') {
        const attempts = errorFen ? (retryMap.get(errorFen) ?? 0) : MAX_RETRIES
        if (attempts < MAX_RETRIES && errorFen) {
          retryMap.set(errorFen, attempts + 1)
          queuedAnalyses.push(errorItem)
        } else {
          if (errorFen) deferReplayFen(errorFen)
          const progress = completeReplayJob({
            completed: replayState.replayQueueCompleted,
            total: replayState.replayQueueTotal,
          })
          replayCompleted = progress.completed
          replayActive = progress.active
        }
      }

      useEngineStore.setState({
        activeMode: replayActive ? replayState.activeMode : null,
        error,
        isLoadingNnue: false,
        replayQueueCompleted: replayCompleted,
        replayQueueActive: replayActive,
        ...(!replayActive ? { isAnalyzing: false } : {}),
      })
      if (pendingRafId !== null) {
        cancelAnimationFrame(pendingRafId)
        pendingRafId = null
      }
      activeFen = null
      activeQueueItem = null
      activeLines = []
      activeDepth = 0
      activeStartedAt = null
      activeLastNps = null
      void processQueue()
    },
    onInfo: (info) => {
      if (!activeFen) return
      if (!isLegalEngineMove(activeFen, info.pv[0])) return

      activeLines = updateLines(activeLines, info)
      activeDepth = Math.max(activeDepth, info.depth)
      if (info.nps != null) {
        activeLastNps = info.nps
      }

      // Coalesce React re-renders to at most one per animation frame.
      // activeLines/activeDepth already hold the latest values and are read
      // at flush time, not at schedule time.
      if (useAppStore.getState().currentFen === activeFen && pendingRafId === null) {
        const fenAtSchedule = activeFen
        pendingRafId = requestAnimationFrame(() => {
          pendingRafId = null
          if (activeFen !== fenAtSchedule) return
          useEngineStore.setState({
            analyzedFen: activeFen,
            currentDepth: activeDepth,
            lines: activeLines,
          })
        })
      }
    },
    onReady: () => {
      useEngineStore.setState({ isLoadingNnue: false, isReady: true })
    },
    onStatus: (status) => {
      if (status === 'initializing') {
        useEngineStore.setState({
          error: null,
          hasAttempted: true,
          isLoadingNnue: false,
          isReady: false,
        })
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
  activeMode: null,
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
  replayQueueActive: false,
  replayQueueCompleted: 0,
  replayQueueTotal: 0,
  replayQueueStartedAt: null,
  replayQueueKind: null,
  highPerformance: readHighPerformance(),
  init: async () => {
    const currentEngine = ensureEngine()
    await currentEngine.init({
      hash: getHashSize(get().highPerformance),
      threads: getThreadCount(),
    })
  },
  setHighPerformance: async (value) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(HIGH_PERF_STORAGE_KEY, String(value))
    }
    if (get().highPerformance === value) return
    set({ highPerformance: value })
    // Hash is only applied at worker init, so changing it means tearing the
    // worker down and rebuilding it. Only do that if the engine is already
    // live; otherwise the next init() picks up the new value for free.
    if (engine) {
      get().stop()
      engine.destroy()
      engine = null
      if (get().enabled) {
        await get().init()
        void get().analyzePosition(useAppStore.getState().currentFen, {
          force: true,
          priority: 'high',
        })
      }
    }
  },
  hydrateAnalysisCache: (persistedByFen) => {
    const entries = Object.entries(persistedByFen)
    if (!entries.length) return

    set((state) => {
      const nextAnalysisByFen = { ...state.analysisByFen }
      let changed = false
      for (const [fen, persisted] of entries) {
        if (persisted.engine !== STOCKFISH_ENGINE_ID) continue
        const existing = nextAnalysisByFen[fen]
        if (existing && existing.depth >= persisted.depth) continue

        const pv = persisted.pv_uci?.split(/\s+/).filter(Boolean) ?? []
        const bestMove = persisted.best_move_uci || pv[0] || null
        if (!bestMove) continue
        if ((persisted.eval_cp == null) === (persisted.eval_mate == null)) continue

        const line: UCIInfo = {
          depth: persisted.depth,
          seldepth: null,
          multipv: persisted.multipv_rank,
          score: whiteScoreToEnginePerspective(fen, persisted.eval_cp, persisted.eval_mate),
          nodes: null,
          nps: null,
          time: null,
          pv: pv.length ? pv : [bestMove],
        }
        // The first move ties the row to this position. The rest of the line
        // was checked move by move by the server's schema on upload, and
        // replaying every stored PV here with chess.js was ~450ms of main
        // thread on loading a 170-move game. Persisted rows are never uploaded
        // again, and the display stops a PV at its first move that will not play.
        if (line.pv[0] !== bestMove || !isLegalEngineMove(fen, bestMove)) continue

        nextAnalysisByFen[fen] = mergeEngineAnalysis(existing, {
          bestMove,
          depth: persisted.depth,
          engine: persisted.engine ?? STOCKFISH_ENGINE_ID,
          lines: [line],
          persisted: true,
        })
        changed = true
      }

      return changed
        ? {
            analysisByFen: trimAnalysisCache(nextAnalysisByFen, useAppStore.getState().currentFen),
            analysisVersion: state.analysisVersion + 1,
          }
        : {}
    })
  },
  queueReplayAnalysis: async (fens, options = {}) => {
    if (options.background) {
      if (!get().enabled) return 0
      const replayCount = queuedAnalyses.filter((item) => item.source === 'replay').length
      let enqueuedCount = 0
      for (const fen of new Set(fens)) {
        const depth = options.depthByFen?.[fen] ?? options.depth ?? get().engineDepth
        if (
          queuedAnalyses.some(
            (item) => item.fen === fen && item.source === 'replay' && item.depth >= depth,
          )
        ) {
          continue
        }
        if (enqueueFen(fen, { depth, priority: 'normal' })) enqueuedCount += 1
      }
      if (!enqueuedCount) return 0
      const added = queuedAnalyses.filter((item) => item.source === 'replay').length - replayCount
      set((state) => ({
        replayQueueActive: true,
        replayQueueCompleted: state.replayQueueActive ? state.replayQueueCompleted : 0,
        replayQueueTotal: state.replayQueueActive ? state.replayQueueTotal + added : added,
        replayQueueStartedAt: state.replayQueueActive ? state.replayQueueStartedAt : Date.now(),
        replayQueueKind: state.replayQueueActive ? state.replayQueueKind : 'library',
      }))
      await processQueue()
      return enqueuedCount
    }

    clearAnalyzeTimer()
    abortGameReview()
    queuedAnalyses = []
    activeQueueItem = null
    engine?.stop()
    clearPositionTimeout()
    retryMap.clear()
    if (pendingRafId !== null) {
      cancelAnimationFrame(pendingRafId)
      pendingRafId = null
    }
    activeFen = null
    activeLines = []
    activeDepth = 0
    activeStartedAt = null
    activeLastNps = null
    activeGeneration += 1

    set({
      lines: [],
      bestMove: null,
      currentDepth: 0,
      analyzedFen: null,
      isAnalyzing: true,
      replayQueueActive: false,
      replayQueueCompleted: 0,
      replayQueueTotal: 0,
      replayQueueStartedAt: null,
    })

    const uniqueFens = Array.from(new Set(fens))
    const requestedDepth = options.depth ?? get().engineDepth
    let enqueuedCount = 0
    for (const fen of uniqueFens) {
      // A decision is graded by differencing its two positions, so each one is
      // searched to the depth its partner already carries rather than to one
      // depth for the whole batch.
      const enqueued = enqueueFen(fen, {
        depth: options.depthByFen?.[fen] ?? requestedDepth,
        priority: 'normal',
      })
      if (enqueued) {
        enqueuedCount += 1
      }
    }

    set({
      replayQueueActive: enqueuedCount > 0,
      replayQueueCompleted: 0,
      replayQueueTotal: enqueuedCount,
      replayQueueStartedAt: enqueuedCount > 0 ? Date.now() : null,
      replayQueueKind: enqueuedCount > 0 ? 'game' : null,
    })

    if (enqueuedCount === 0) {
      set({ isAnalyzing: false })
      return 0
    }

    // Requesting a game review is an explicit request to run the engine, even
    // if interactive analysis was previously switched off.
    set({ enabled: true })
    // The review's positions go to their own pool; the main engine stays free
    // for the position on the board.
    const reviewJobs = queuedAnalyses.filter((item) => item.source === 'replay')
    queuedAnalyses = queuedAnalyses.filter((item) => item.source !== 'replay')
    void runGameReview(reviewJobs)
    return enqueuedCount
  },
  playMove: async (fen, { depth, multiPV }) => {
    clearAnalyzeTimer()
    // Put whatever was being analysed back at the head of the queue: the
    // worker stops that search to run this one, and it resumes afterwards.
    if (activeFen && activeQueueItem) {
      queuedAnalyses = [activeQueueItem, ...queuedAnalyses]
    }
    clearPositionTimeout()
    if (pendingRafId !== null) {
      cancelAnimationFrame(pendingRafId)
      pendingRafId = null
    }
    activeFen = null
    activeQueueItem = null
    activeLines = []
    activeDepth = 0
    activeStartedAt = null
    activeLastNps = null
    activeGeneration += 1
    botSearchActive = true
    set({ activeMode: null, isAnalyzing: false })
    try {
      await get().init()
      return await ensureEngine().play(fen, {
        depth,
        multiPV: Math.min(multiPV, getLegalMoveCount(fen) ?? multiPV),
      })
    } finally {
      botSearchActive = false
      void processQueue()
    }
  },
  stop: () => {
    clearAnalyzeTimer()
    abortGameReview()
    clearPositionTimeout()
    engine?.stop()
    if (pendingRafId !== null) {
      cancelAnimationFrame(pendingRafId)
      pendingRafId = null
    }
    queuedAnalyses = []
    activeQueueItem = null
    activeFen = null
    activeLines = []
    activeDepth = 0
    activeStartedAt = null
    activeLastNps = null
    retryMap.clear()
    set({
      activeMode: null,
      isAnalyzing: false,
      replayQueueActive: false,
      replayQueueCompleted: 0,
      replayQueueTotal: 0,
      replayQueueStartedAt: null,
    })
  },
  toggle: async () => {
    if (get().enabled) {
      clearAnalyzeTimer()
      abortGameReview()
      clearPositionTimeout()
      engine?.stop()
      if (pendingRafId !== null) {
        cancelAnimationFrame(pendingRafId)
        pendingRafId = null
      }
      queuedAnalyses = []
      activeQueueItem = null
      activeFen = null
      activeLines = []
      activeDepth = 0
      activeStartedAt = null
      activeLastNps = null
      retryMap.clear()
      set({
        analyzedFen: null,
        activeMode: null,
        bestMove: null,
        currentDepth: 0,
        enabled: false,
        error: null,
        isAnalyzing: false,
        lines: [],
        replayQueueActive: false,
        replayQueueCompleted: 0,
        replayQueueTotal: 0,
        replayQueueStartedAt: null,
      })
      return
    }
    set({ enabled: true, error: null })
    await get().init()
    await get().analyzePosition(useAppStore.getState().currentFen, {
      force: true,
      priority: 'high',
    })
  },
  setEngineDepth: (depth) => {
    set({ engineDepth: depth })
    if (get().enabled) {
      void get().analyzePosition(useAppStore.getState().currentFen, {
        force: true,
        priority: 'high',
      })
    }
  },
  analyzePosition: async (fen, options = {}) => {
    clearAnalyzeTimer()
    if (!get().enabled) return
    if (getTerminalOutcome(fen)) {
      set({
        analyzedFen: fen,
        bestMove: null,
        currentDepth: 0,
        lines: [],
        isAnalyzing: false,
        activeMode: null,
        error: null,
      })
      return
    }

    const requestedDepth = options.depth ?? get().engineDepth
    const cachedAnalysis = getCachedAnalysis(fen)
    const requestedMultiPV = Math.min(
      getLegalMoveCount(fen) ?? 3,
      options.priority === 'normal'
        ? 1
        : options.deep
          ? 3
          : (options.stable ?? Boolean(cachedAnalysis))
            ? 2
            : 1,
    )
    if (cachedAnalysis) {
      setCurrentFromCache(fen)
      const availableMultiPV = cachedAnalysis.lines.filter(
        (line) => line.multipv <= requestedMultiPV && line.depth >= requestedDepth,
      ).length
      if (
        !needsEngineAnalysis(
          cachedAnalysis.depth,
          requestedDepth,
          options.force,
          availableMultiPV,
          requestedMultiPV,
        )
      ) {
        set({ isAnalyzing: false })
        return
      }
    }

    if (!cachedAnalysis) {
      set({
        activeMode: options.deep ? 'deep' : 'quick',
        analyzedFen: fen,
        bestMove: null,
        currentDepth: 0,
        error: null,
        hasAttempted: true,
        isAnalyzing: true,
        lines: [],
      })
    } else {
      set({
        activeMode: options.deep ? 'deep' : 'standard',
        hasAttempted: true,
        isAnalyzing: true,
        error: null,
      })
    }

    // The quick→stable two-pass dance exists to show *something* fast when the
    // board has no eval yet. When a cached eval is already on screen
    // (setCurrentFromCache above), the shallow quick pass is invisible churn —
    // go straight to a single full-depth (stable) pass instead.
    const primaryStable = options.stable ?? options.deep ?? Boolean(cachedAnalysis)

    analyzeTimer = window.setTimeout(() => {
      const prio = options.priority ?? 'high'
      const enqueued = enqueueFen(fen, {
        ...options,
        depth: requestedDepth,
        priority: prio,
        stable: primaryStable,
      })
      void processQueue(enqueued && prio === 'high')
    }, ANALYZE_DEBOUNCE_MS)

    if (!options.deep && !cachedAnalysis && (options.priority ?? 'high') === 'high') {
      stableAnalyzeTimer = window.setTimeout(() => {
        if (useAppStore.getState().currentFen !== fen) return
        enqueueFen(fen, { depth: requestedDepth, priority: 'high', stable: true })
        void processQueue(false)
      }, STABLE_ANALYZE_DELAY_MS)
    }
  },
}))
