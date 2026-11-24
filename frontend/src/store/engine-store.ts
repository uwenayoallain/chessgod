import { create } from 'zustand'

import {
  isReviewBandDepth,
  MAX_PAIR_DEPTH_GAP,
  mergeEngineAnalysis,
  needsEngineAnalysis,
  reviewLineOf,
} from '@/lib/analysis/analysis-cache'
import { shouldAutoAnalyze } from '@/lib/analysis/auto-analysis'
import { GAME_REVIEW_DEPTH, MIN_TRUSTED_DEPTH } from '@/lib/analysis/review-depth'
import {
  chooseEngineMode,
  completeReplayJob,
  enqueueAnalysisJob,
  handleReplayTimeout,
  type AnalysisJob,
  type AnalysisMode,
} from '@/lib/stockfish/analysis-policy'
import { StockfishEngine } from '@/lib/stockfish/engine'
import {
  createWarmPool,
  reviewPoolSize,
  runReviewPool,
  type BorrowedEngine,
  type ReviewJob,
} from '@/lib/stockfish/review-pool'
import {
  getLegalMoveCount,
  getTerminalOutcome,
  isLegalEngineLine,
  isLegalEngineMove,
} from '@/lib/stockfish/legal-analysis'
import type { UCIInfo } from '@/lib/stockfish/uci'
import { STOCKFISH_ENGINE_ID } from '@/lib/stockfish/version'
import { safeGetItem, safeSetItem } from '@/lib/storage'
import { getTelemetryNowMs, reportFrontendEvent } from '@/lib/telemetry'
import { useAppStore } from '@/store/app-store'
import { useSparStore } from '@/store/spar-store'

// The depth a look at the board aims for. Every look also stops at
// INTERACTIVE_MOVETIME_MS (analysis-policy.ts): 30 on two threads of a laptop
// was a 90-second search per position that never arrived, with two cores held
// at full boost the whole time. 26 is usually reached inside the time limit,
// and the depth selector still offers 30 and 34 to anyone who wants them.
const DEFAULT_DEPTH = 26
const ANALYZE_DEBOUNCE_MS = 60
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
  /**
   * A game review's position: done when it carries a line at about the review
   * depth (`reviewLineOf`), however deep the board has searched it since.
   */
  review?: boolean
}

export type CachedEngineAnalysis = {
  bestMove: string | null
  depth: number
  engine?: string
  lines: UCIInfo[]
  /**
   * The review-depth rank-one line a deeper board search displaced from
   * `lines`; the game review grades from it (analysis-cache.ts).
   */
  reviewLine?: UCIInfo
  persisted?: boolean
  /** Whether `reviewLine` is stored on the server; `persisted` covers `lines`. */
  reviewLinePersisted?: boolean
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
  /**
   * Drop board searches only, keeping a game review and the library crawl:
   * for when nothing on screen reads the board any more.
   */
  stopInteractive: () => void
  /**
   * Drop the library crawl only: its queued positions, and the main engine's
   * search when that search is one of them. A game review on its own pool and
   * the board search are left alone, so the crawl's Stop button never ends a
   * review the player is reading.
   */
  stopLibraryCrawl: () => void
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
  // Read through the guarded helper: with site data blocked the bare accessor
  // throws, and this runs while the store is being created.
  return safeGetItem(HIGH_PERF_STORAGE_KEY) === 'true'
}

let engine: StockfishEngine | null = null
let analyzeTimer: number | null = null
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
// analysis queue waits rather than stopping that search to start its own. A
// count, not a flag: two `playMove` calls can overlap (a takeback while the
// opponent is thinking), and the first to finish must not hand the worker to
// the queue while the second is still searching on it.
let botSearchCount = 0
// The game review running on its own pool of engines, if any.
let reviewAbort: AbortController | null = null
// The last review started, settling once its pool has handed every engine
// back. A review that replaces it waits for that, so it starts on the same
// engines (warm, and the main engine with them) instead of building new ones
// beside workers that are still on their way out.
let reviewRun: Promise<void> | null = null
// Each pool engine keeps a small table: it searches one position at a time.
const REVIEW_HASH_MB = 32
// What one review position may search before it stops short of its depth. A
// single-threaded engine reaches GAME_REVIEW_DEPTH in about two seconds on a
// typical middlegame, so this is twice that; a sharp position that would have
// held an engine for a minute stops here instead, and the pool keeps what it
// reached when that is deep enough to grade from.
const REVIEW_MOVETIME_MS = 4_000
/**
 * How long the review's own engines are kept after a review. Another game
 * opened straight after, or the same one asked again, then starts on workers
 * that already hold the network instead of compiling the wasm and copying
 * ~98MB of network into each new one. Short, because each holds ~450MB.
 */
export const REVIEW_WARM_MS = 50_000
// Pool engines whose worker reported an error: never kept warm.
const failedReviewEngines = new WeakSet<StockfishEngine>()

function createReviewEngine() {
  const created: StockfishEngine = new StockfishEngine({
    onInfo: () => {},
    onBestMove: () => {},
    onReady: () => {},
    onStatus: () => {},
    onError: (message) => {
      failedReviewEngines.add(created)
      emitEngineEvent('engine_error', { error_message: message })
    },
  })
  return created
}

const reviewEngines = createWarmPool({ create: createReviewEngine, idleMs: REVIEW_WARM_MS })

/**
 * The main engine while a game review searches on it. A review runs on a pool
 * of single-threaded engines, and the main engine used to sit idle beside it
 * holding ~0.5-1GB (its wasm, the network and the board's hash) while the pool
 * built new workers of its own. Lent to the pool instead, it does the work of
 * as many pool engines as it has threads, so the review costs one or two fewer
 * workers. It is never destroyed by the pool, only handed back.
 *
 * Nothing is reconfigured for the loan: the worker applies Threads and Hash
 * only when it starts, and changing them later would need a command the worker
 * does not have. So it keeps its two threads and its board hash, and counts as
 * two of the pool's single-threaded engines (see `runReviewPool`): the cores
 * see the same number of searches as before, and there is nothing to restore
 * when it comes back.
 */
type MainLease = {
  engine: StockfishEngine
  revoke: AbortController
  returned: Promise<void>
  failed: boolean
}
let mainLease: MainLease | null = null

/** Lend the main engine to a review, when it is ready and nothing else needs it. */
function lendMainEngine(): BorrowedEngine | null {
  const lent = engine
  if (!lent || mainLease) return null
  const state = useEngineStore.getState()
  if (!state.enabled || !state.isReady) return null
  // A board search, the opponent's move, or a game in progress (which needs
  // the engine between moves) keep it.
  if (activeFen !== null || botSearchCount > 0) return null
  if (useSparStore.getState().status === 'playing') return null
  let settle = () => {}
  const returned = new Promise<void>((resolve) => {
    settle = resolve
  })
  const lease: MainLease = { engine: lent, revoke: new AbortController(), returned, failed: false }
  mainLease = lease
  return {
    engine: lent,
    threads: getThreadCount(),
    revoke: lease.revoke.signal,
    release: (healthy) => {
      if (mainLease === lease) mainLease = null
      settle()
      // A search it had to abandon, or an error from its worker: build a new
      // one for the board rather than trust this one again.
      if ((!healthy || lease.failed) && engine === lent) discardMainEngine()
    },
  }
}

/**
 * Take the main engine back from a review that borrowed it. The review stops
 * its search on it, puts that position back for its other engines, and fills
 * the threads it held with engines of its own; this resolves once it is free.
 */
async function reclaimMainEngine() {
  const lease = mainLease
  if (!lease) return
  lease.revoke.abort()
  await lease.returned
}

/** Drop the review's warm engines, and any it still holds when it settles. */
function dropReviewEngines() {
  reviewEngines.reset()
}
// Positions of the running review, by the depth each was asked for, so a
// second request for the same game reuses the review instead of restarting it.
let reviewDepthByFen = new Map<string, number>()
// Board positions the running review's pool searched ahead of its own work,
// because the player stepped onto them (see `takePriorityReviewJob`). Each is
// served once per review; the board search still deepens it afterwards.
let priorityServed = new Set<string>()
// Review positions whose search stopped at its time limit (REVIEW_MOVETIME_MS)
// short of the depth asked for but deep enough to grade from, by the depth it
// reached. Another request for the same game treats them as done, as the
// board does with `interactiveCaps`: a second review of the same position gets
// the same four seconds and stops at the same depth, so restarting the pool or
// retrying it for eight more seconds buys nothing. The depth that search was
// asked for is kept with it: the cap says what four seconds reach, which is no
// reason to refuse a deeper review that is given longer.
type ReviewCap = { askedDepth: number; reachedDepth: number }
const reviewCaps = new Map<string, ReviewCap>()
// Board positions whose look stopped at its time limit short of the depth asked
// for, by the depth it reached. Stepping back onto one shows what it reached
// instead of searching it all over again for the same twelve seconds, which is
// all a capped search would ever get. A deep look, or a forced one, still goes.
const interactiveCaps = new Map<string, number>()
const MAX_INTERACTIVE_CAPS = 2_000
// The depth a new search has to reach before it replaces lines already on the
// board for its position. Refining a position must never blank its evaluation.
let activeDisplayFloor = 0

function rememberCap<T>(caps: Map<string, T>, fen: string, cap: T) {
  caps.delete(fen)
  caps.set(fen, cap)
  if (caps.size > MAX_INTERACTIVE_CAPS) {
    const oldest = caps.keys().next().value
    if (oldest) caps.delete(oldest)
  }
}

function rememberInteractiveCap(fen: string, depth: number) {
  rememberCap(interactiveCaps, fen, depth)
}

/**
 * Whether a game review asking for `fen` at `depth` has nothing left to do.
 *
 * Up to the review band, what counts is a rank-one line at about the review
 * depth, not the deepest search: a position studied on the board at 26 has no
 * evaluation a move can be graded against when its partner was reviewed at
 * 20, so it is searched again at 20 and the two are kept side by side. A
 * position whose review stopped at its time limit counts as done at the depth
 * it reached (`reviewCaps`), but only for a request no deeper than the one
 * that was cut short: a depth-20 review stopping at 18 must not turn away a
 * review asked for at 22 or 26, which gets a longer limit or none.
 */
function reviewCovers(fen: string, depth: number) {
  const cached = getCachedAnalysis(fen)
  if (!cached) return false
  const cap = reviewCaps.get(fen)
  const target = cap != null && depth <= cap.askedDepth ? Math.min(depth, cap.reachedDepth) : depth
  const line =
    depth <= GAME_REVIEW_DEPTH + MAX_PAIR_DEPTH_GAP
      ? reviewLineOf(cached)
      : cached.lines.find((candidate) => candidate.multipv === 1)
  return line != null && line.depth >= target
}

/** The time limit for one review position: longer for the rare deeper job. */
function reviewMovetime(depth: number) {
  if (depth > GAME_REVIEW_DEPTH + 2) return undefined
  return REVIEW_MOVETIME_MS * 2 ** Math.max(0, depth - GAME_REVIEW_DEPTH)
}

/**
 * The main engine is released after this long with nothing to do. Its worker
 * holds ~450MB of wasm plus its hash (~0.95GB, ~1.45GB with the deeper search)
 * and used to hold it from page load until the tab closed, Review tab and
 * all. The next search builds a new one; re-init reads the net from the cache.
 */
export const ENGINE_IDLE_RELEASE_MS = 5 * 60_000
let lastEngineActivity = 0
let idleTimer: number | null = null

function engineBusy() {
  return (
    activeFen !== null ||
    queuedAnalyses.length > 0 ||
    botSearchCount > 0 ||
    reviewAbort !== null ||
    mainLease !== null ||
    analyzeTimer != null ||
    // Between the opponent's moves nothing is searching, but the game needs it.
    useSparStore.getState().status === 'playing'
  )
}

function checkEngineIdle() {
  idleTimer = null
  if (!engine) return
  const idleFor = Date.now() - lastEngineActivity
  if (engineBusy() || idleFor < ENGINE_IDLE_RELEASE_MS) {
    const wait = engineBusy() ? ENGINE_IDLE_RELEASE_MS : ENGINE_IDLE_RELEASE_MS - idleFor
    idleTimer = window.setTimeout(checkEngineIdle, wait)
    return
  }
  releaseEngine()
}

/** Record engine work, so the idle release counts from the last of it. */
function touchEngine() {
  lastEngineActivity = Date.now()
  if (idleTimer == null && typeof window !== 'undefined') {
    idleTimer = window.setTimeout(checkEngineIdle, ENGINE_IDLE_RELEASE_MS)
  }
}

/**
 * Tear the main worker down, and the review's warm engines with it. Cached
 * lines stay; only the workers go.
 */
function releaseEngine() {
  if (idleTimer != null) {
    window.clearTimeout(idleTimer)
    idleTimer = null
  }
  dropReviewEngines()
  discardMainEngine()
}

/** Destroy the main worker only; the next search builds a new one. */
function discardMainEngine() {
  if (!engine) return
  if (mainLease?.engine === engine) mainLease = null
  engine.destroy()
  engine = null
  useEngineStore.setState({ isReady: false, isLoadingNnue: false, hasAttempted: false })
}

function abortGameReview() {
  reviewAbort?.abort()
  reviewAbort = null
  reviewDepthByFen = new Map()
  priorityServed = new Set()
}

/**
 * Merge one pool search into the cache exactly as a queued search would be.
 * A position searched ahead of the review because the player stepped onto it
 * is not one of the review's own, so it does not count toward its progress.
 */
function recordReviewResult(fen: string, lines: UCIInfo[] | null, reviewPosition = true) {
  const askedDepth = reviewDepthByFen.get(fen)
  if (reviewPosition) reviewDepthByFen.delete(fen)
  const legal = (lines ?? []).filter((line) => isLegalEngineLine(fen, line))
  const top = legal.find((line) => line.multipv === 1)
  if (
    reviewPosition &&
    top &&
    askedDepth != null &&
    top.depth < askedDepth &&
    top.depth >= MIN_TRUSTED_DEPTH
  ) {
    rememberCap(reviewCaps, fen, { askedDepth, reachedDepth: top.depth })
  }
  useEngineStore.setState((s) => {
    const progress = reviewPosition
      ? completeReplayJob({ completed: s.replayQueueCompleted, total: s.replayQueueTotal })
      : { completed: s.replayQueueCompleted }
    if (!top) return { replayQueueCompleted: progress.completed }
    const merged = mergeEngineAnalysis<CachedEngineAnalysis>(s.analysisByFen[fen], {
      bestMove: top.pv[0] ?? null,
      depth: top.depth,
      engine: STOCKFISH_ENGINE_ID,
      lines: legal,
    })
    // The board search waits while a review runs, so the review's answer is
    // what the board shows for a position on the reviewed line.
    const onBoard = useAppStore.getState().currentFen === fen && activeFen !== fen
    return {
      replayQueueCompleted: progress.completed,
      analysisByFen: trimAnalysisCache({ ...s.analysisByFen, [fen]: merged }, fen),
      analysisVersion: s.analysisVersion + 1,
      ...(onBoard
        ? {
            analyzedFen: fen,
            bestMove: merged.bestMove,
            currentDepth: merged.depth,
            lines: merged.lines,
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
/**
 * The position on the board, when the player has stepped onto one the running
 * review is not searching and nothing has searched yet: a side line tried
 * during the review. The board search waits for the review (it would compete
 * with the pool for the cores), so the next pool engine to come free searches
 * it before its own next position, and the player gets lines in seconds
 * instead of after the whole game.
 */
function takePriorityReviewJob(): ReviewJob | null {
  if (!useEngineStore.getState().enabled) return null
  const currentFen = useAppStore.getState().currentFen
  if (reviewDepthByFen.has(currentFen) || priorityServed.has(currentFen)) return null
  const job = queuedAnalyses.find(
    (queued) => queued.source === 'interactive' && queued.fen === currentFen,
  )
  if (!job || getTerminalOutcome(job.fen)) return null
  if ((getCachedAnalysis(job.fen)?.depth ?? 0) >= MIN_TRUSTED_DEPTH) return null
  // The queued job stays queued: the board search deepens it once the review
  // is over, while this quick answer fills the board in the meantime.
  priorityServed.add(job.fen)
  return {
    fen: job.fen,
    depth: job.depth,
    multiPV: job.multiPV,
    movetimeMs: REVIEW_MOVETIME_MS,
  }
}

async function runGameReview(jobs: AnalysisJob[]) {
  const previous = reviewRun
  abortGameReview()
  const controller = new AbortController()
  reviewAbort = controller
  reviewDepthByFen = new Map(jobs.map((job) => [job.fen, job.depth]))
  priorityServed = new Set()
  let settle = () => {}
  const run = new Promise<void>((resolve) => {
    settle = resolve
  })
  reviewRun = run
  try {
    // The review this one replaces hands its engines back first (an aborted
    // search settles at once), so they are reused rather than built again.
    if (previous) await previous
    if (controller.signal.aborted) return
    await runReviewPool({
      jobs: jobs.map((job) => {
        const movetimeMs = reviewMovetime(job.depth)
        return { fen: job.fen, depth: job.depth, ...(movetimeMs != null ? { movetimeMs } : {}) }
      }),
      size: reviewPoolSize(),
      hash: REVIEW_HASH_MB,
      signal: controller.signal,
      borrow: lendMainEngine(),
      create: () => reviewEngines.acquire(),
      retire: (poolEngine, healthy) => {
        const reviewEngine = poolEngine as StockfishEngine
        reviewEngines.release(reviewEngine, healthy && !failedReviewEngines.has(reviewEngine))
      },
      priority: takePriorityReviewJob,
      onResult: (job, lines) => recordReviewResult(job.fen, lines, !priorityServed.has(job.fen)),
    })
  } catch (error) {
    // The review is started fire-and-forget, so a pool that cannot run at all
    // (worker construction failed) must be reported here, not escape as an
    // unhandled rejection with no finally cleanup observed.
    emitEngineEvent('engine_error', {
      error_message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    settle()
    if (reviewRun === run) reviewRun = null
    // Switched off mid-review: no worker is left to count idle time for.
    if (engine) touchEngine()
    if (reviewAbort === controller) {
      reviewAbort = null
      reviewDepthByFen = new Map()
      useEngineStore.setState({
        replayQueueActive: false,
        isAnalyzing: activeFen !== null || queuedAnalyses.length > 0,
        activeMode: activeQueueItem?.mode ?? null,
      })
      priorityServed = new Set()
      // The board search waited for the review; it runs now.
      void processQueue()
      resumeBoardAfterReview()
    }
  }
}

/**
 * After a review, the board must show the position it stands on. Each review
 * result lands on the board as it arrives, but a position the player moved to
 * that the review never searched, with no board search queued for it, would
 * otherwise sit on another position's lines until the next move.
 */
function resumeBoardAfterReview() {
  const state = useEngineStore.getState()
  const currentFen = useAppStore.getState().currentFen
  if (!state.enabled || state.analyzedFen === currentFen) return
  if (activeFen === currentFen || queuedAnalyses.some((job) => job.fen === currentFen)) return
  if (setCurrentFromCache(currentFen)) return
  if (!shouldAutoAnalyze(currentFen)) return
  void state.analyzePosition(currentFen, { priority: 'high' })
}

/**
 * Whether a request to review `fens` asks for nothing the running review is
 * not already doing. Loading a game and opening its review both ask for the
 * same positions within a moment of each other, and each request used to tear
 * the pool down (destroying every worker and its copy of the network) and
 * build it again from the start.
 */
function runningReviewCovers(fens: string[], depthFor: (fen: string) => number) {
  if (!reviewAbort || reviewDepthByFen.size === 0) return null
  let remaining = 0
  for (const fen of new Set(fens)) {
    if (getTerminalOutcome(fen)) continue
    const depth = depthFor(fen)
    if (reviewCovers(fen, depth)) continue
    const running = reviewDepthByFen.get(fen)
    if (running == null || running < depth) return null
    remaining += 1
  }
  return remaining > 0 ? remaining : null
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
    // everything (six times in one session, each after 90 seconds and at
    // depth 26), so returning to the position started the search from zero.
    if (timedOutItem?.source === 'interactive' && storableLines(timedOutFen, activeLines).length) {
      engine?.stop()
      if (activeDepth < timedOutItem.depth) rememberInteractiveCap(timedOutFen, activeDepth)
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
 * lines are checked on their first move only: replaying every PV with
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
  if (options.review && !options.force) {
    if (reviewCovers(fen, mode.depth)) return false
  } else if (
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
    !options.review &&
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
    ...(mode.movetime != null ? { movetime: mode.movetime } : {}),
  }

  queuedAnalyses = enqueueAnalysisJob(queuedAnalyses, item)
  return true
}

function completeActiveAnalysis(bestMove: string | null, provider = STOCKFISH_ENGINE_ID) {
  if (!activeFen) return
  touchEngine()
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
  if (
    completedItem?.source === 'interactive' &&
    completedItem.movetime != null &&
    completedAnalysis.depth < completedItem.depth
  ) {
    // Stopped by its time limit: what it reached is the answer for now.
    rememberInteractiveCap(completedFen, completedAnalysis.depth)
  }
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

/**
 * Stop the search in hand and keep what it reached, as an interrupt does: the
 * lines found so far are cached. A replay job goes back in the queue, behind
 * the board search that interrupted it: counting it as done lost the position
 * from the library run for good whenever the player stepped through a game
 * while the crawl was working.
 */
function interruptActive() {
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
    const interrupted = activeQueueItem
    const boardJobs = queuedAnalyses.filter((job) => job.source === 'interactive')
    const rest = queuedAnalyses.filter(
      (job) =>
        job.source !== 'interactive' && !(job.source === 'replay' && job.fen === interrupted.fen),
    )
    queuedAnalyses = [...boardJobs, interrupted, ...rest]
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

async function processQueue(interrupt = false) {
  const state = useEngineStore.getState()

  if (botSearchCount > 0 || !state.enabled || !queuedAnalyses.length) {
    return
  }
  // A game review has its own pool of engines, sized to leave the machine one
  // core. The main engine's two threads on top of it oversubscribed the cores
  // and slowed the review and the board alike, so the board waits for it; the
  // review's own results show on the board as they land.
  if (reviewAbort !== null) return

  if (activeFen) {
    if (!interrupt) return
    interruptActive()
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

  const cachedForItem = getCachedAnalysis(nextItem.fen)
  // Lines already known for this position stay on the board until the new
  // search has gone as deep: refining a position must not blank it.
  activeDisplayFloor = cachedForItem ? Math.min(cachedForItem.depth, nextItem.depth) : 0
  if (useAppStore.getState().currentFen === nextItem.fen) {
    useEngineStore.setState({
      analyzedFen: nextItem.fen,
      bestMove: cachedForItem?.bestMove ?? null,
      currentDepth: cachedForItem?.depth ?? 0,
      error: null,
      hasAttempted: true,
      isAnalyzing: true,
      lines: cachedForItem?.lines ?? [],
      activeMode: nextItem.mode,
    })
  } else {
    useEngineStore.setState({ activeMode: nextItem.mode, isAnalyzing: true })
  }

  const generation = activeGeneration
  touchEngine()
  // A review that was just stopped may still be handing the engine back.
  if (mainLease) await reclaimMainEngine()
  await state.init()
  if (activeGeneration !== generation || activeFen !== nextItem.fen) return

  ensureEngine().analyze(nextItem.fen, {
    depth: nextItem.depth,
    force: true,
    multiPV: nextItem.multiPV,
    ...(nextItem.movetime != null ? { movetime: nextItem.movetime } : {}),
  })
  startPositionTimeout()
}

function ensureEngine() {
  if (engine) return engine

  engine = new StockfishEngine({
    onBestMove: (bestMove) => completeActiveAnalysis(bestMove),
    onError: (error) => {
      if (mainLease && mainLease.engine === engine) mainLease.failed = true
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
      if (
        useAppStore.getState().currentFen === activeFen &&
        activeDepth >= activeDisplayFloor &&
        pendingRafId === null
      ) {
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
    touchEngine()
    const currentEngine = ensureEngine()
    await currentEngine.init({
      hash: getHashSize(get().highPerformance),
      threads: getThreadCount(),
    })
  },
  setHighPerformance: async (value) => {
    // A refused write lasts for this visit only; the switch still works.
    safeSetItem(HIGH_PERF_STORAGE_KEY, String(value))
    if (get().highPerformance === value) return
    set({ highPerformance: value })
    // Hash is only applied at worker init, so changing it means tearing the
    // worker down and rebuilding it. Only do that if the engine is already
    // live; otherwise the next init() picks up the new value for free.
    if (engine) {
      get().stop()
      discardMainEngine()
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
        // A shallower row is still wanted when it is the review-depth search
        // a deeper board search left this position without: the review grades
        // from it (`reviewLine`), and `prefer_depth` is how it was asked for.
        if (
          existing &&
          existing.depth >= persisted.depth &&
          !(isReviewBandDepth(persisted.depth) && !reviewLineOf(existing))
        ) {
          continue
        }

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

    const requestedReviewDepth = options.depth ?? get().engineDepth
    const reused = runningReviewCovers(
      fens,
      (fen) => options.depthByFen?.[fen] ?? requestedReviewDepth,
    )
    if (reused != null) {
      // Already being searched by the running review: leave it running.
      set({ enabled: true })
      return reused
    }

    abortGameReview()
    // Only the library crawl's positions give way to a game review. The board
    // search is kept: queued behind the review, or searched ahead of it by a
    // pool engine when it is a side line (`takePriorityReviewJob`).
    const libraryJobs = queuedAnalyses.filter((job) => job.source === 'replay')
    queuedAnalyses = queuedAnalyses.filter((job) => job.source !== 'replay')
    let enqueuedCount = 0
    for (const fen of new Set(fens)) {
      // A decision is graded by differencing its two positions, so each one is
      // searched to the depth its partner already carries rather than to one
      // depth for the whole batch.
      const enqueued = enqueueFen(fen, {
        depth: options.depthByFen?.[fen] ?? requestedReviewDepth,
        priority: 'normal',
        review: true,
      })
      if (enqueued) enqueuedCount += 1
    }
    const reviewJobs = queuedAnalyses.filter((job) => job.source === 'replay')
    queuedAnalyses = queuedAnalyses.filter((job) => job.source !== 'replay')

    if (enqueuedCount === 0) {
      // Nothing to review: whatever the engine was doing carries on.
      queuedAnalyses = [...queuedAnalyses, ...libraryJobs]
      if (get().replayQueueKind === 'game') {
        set({
          replayQueueActive: false,
          replayQueueCompleted: 0,
          replayQueueTotal: 0,
          replayQueueStartedAt: null,
          replayQueueKind: null,
        })
      }
      set({ isAnalyzing: activeFen !== null || queuedAnalyses.length > 0 })
      void processQueue()
      return 0
    }

    // The review's pool takes the cores, so the search in hand stops and keeps
    // what it reached. A board search goes back in the queue to run after.
    const boardJob = activeQueueItem?.source === 'interactive' ? activeQueueItem : null
    if (activeFen) interruptActive()
    queuedAnalyses = queuedAnalyses.filter((job) => job.source === 'interactive')
    if (boardJob && !queuedAnalyses.length) queuedAnalyses = [boardJob]
    retryMap.clear()

    // The board keeps what is known about the position it stands on. Blanking
    // it emptied the lines of a position already analysed (a mistake opened
    // from Needs Work lands on one) until the review got round to it.
    const currentFen = useAppStore.getState().currentFen
    if (!setCurrentFromCache(currentFen) && get().analyzedFen !== currentFen) {
      set({ lines: [], bestMove: null, currentDepth: 0, analyzedFen: null })
    }
    set({
      isAnalyzing: true,
      replayQueueActive: true,
      replayQueueCompleted: 0,
      replayQueueTotal: enqueuedCount,
      replayQueueStartedAt: Date.now(),
      replayQueueKind: 'game',
      // Requesting a game review is an explicit request to run the engine,
      // even if interactive analysis was previously switched off.
      enabled: true,
    })
    // The review's positions go to their own pool; the main engine stays free
    // for the position on the board.
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
    botSearchCount += 1
    set({ activeMode: null, isAnalyzing: false })
    try {
      // The opponent's search needs the main engine; a review that borrowed
      // it hands it back and carries on with engines of its own.
      await reclaimMainEngine()
      await get().init()
      return await ensureEngine().play(fen, {
        depth,
        multiPV: Math.min(multiPV, getLegalMoveCount(fen) ?? multiPV),
      })
    } finally {
      botSearchCount = Math.max(0, botSearchCount - 1)
      touchEngine()
      if (botSearchCount === 0) void processQueue()
    }
  },
  stopInteractive: () => {
    clearAnalyzeTimer()
    queuedAnalyses = queuedAnalyses.filter((job) => job.source !== 'interactive')
    if (activeQueueItem?.source === 'interactive') interruptActive()
    if (queuedAnalyses.length) void processQueue()
    else if (!activeFen) set({ activeMode: null, isAnalyzing: false })
  },
  stopLibraryCrawl: () => {
    const crawling = queuedAnalyses.some((job) => job.source === 'replay')
    queuedAnalyses = queuedAnalyses.filter((job) => job.source !== 'replay')
    const searchingCrawl = activeQueueItem?.source === 'replay'
    if (searchingCrawl) {
      interruptActive()
      // `interruptActive` puts a replay job back for later; this one is dropped.
      queuedAnalyses = queuedAnalyses.filter((job) => job.source !== 'replay')
    }
    for (const fen of retryMap.keys()) {
      if (!reviewDepthByFen.has(fen)) retryMap.delete(fen)
    }
    // Idle review engines only: a running review keeps the ones it is using.
    reviewEngines.dropIdle()
    // A running game review owns the replay progress; leave it to report.
    if (
      reviewAbort === null &&
      (crawling || searchingCrawl || get().replayQueueKind === 'library')
    ) {
      set({
        replayQueueActive: false,
        replayQueueCompleted: 0,
        replayQueueTotal: 0,
        replayQueueStartedAt: null,
        replayQueueKind: null,
      })
    }
    if (queuedAnalyses.length) void processQueue()
    else if (!activeFen && reviewAbort === null) set({ activeMode: null, isAnalyzing: false })
  },
  stop: () => {
    clearAnalyzeTimer()
    abortGameReview()
    // Stopped by hand (or to hand the engine to the opponent): no warm
    // workers wait for a next review that is not coming.
    dropReviewEngines()
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
      // Turned off by hand: give the memory back now, not in five minutes.
      releaseEngine()
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

    const cachedAnalysis = getCachedAnalysis(fen)
    const cap = options.force || options.deep ? undefined : interactiveCaps.get(fen)
    const askedDepth = options.depth ?? get().engineDepth
    // A position whose last look stopped at its time limit is not searched
    // again for the same limit: the board shows what that look reached.
    const requestedDepth =
      cap != null && cachedAnalysis && cachedAnalysis.depth >= cap
        ? Math.min(askedDepth, cachedAnalysis.depth)
        : askedDepth
    const requestedMultiPV = Math.min(
      getLegalMoveCount(fen) ?? 3,
      options.priority === 'normal' ? 1 : options.deep ? 3 : 2,
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
      // Another position's lines must not stand on this one's board.
      set({
        activeMode: options.deep ? 'deep' : 'standard',
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

    // One search per position. A shallow single-line pass used to run first,
    // then a second search started from depth 1 with two lines 650ms later:
    // the evaluation blanked and climbed twice, and the first pass was thrown
    // away. Lines stream from the first iteration anyway, so the full search
    // shows something just as fast.
    analyzeTimer = window.setTimeout(() => {
      // Spent: a fired timer left set reads as pending work forever.
      analyzeTimer = null
      const prio = options.priority ?? 'high'
      const enqueued = enqueueFen(fen, {
        ...options,
        depth: requestedDepth,
        priority: prio,
        stable: true,
      })
      void processQueue(enqueued && prio === 'high')
    }, ANALYZE_DEBOUNCE_MS)
  },
}))

// A game against the engine needs the main engine between moves and the
// machine to itself: the review's idle engines go now, and a review still
// running gives the main engine back before the opponent's first move asks.
useSparStore.subscribe((state, previous) => {
  if (state.status !== 'playing' || previous.status === 'playing') return
  reviewEngines.dropIdle()
  void reclaimMainEngine()
})
