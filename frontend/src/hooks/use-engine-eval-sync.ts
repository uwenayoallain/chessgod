import { useEffect } from 'react'
import { isAxiosError } from 'axios'

import { isReviewBandDepth } from '@/lib/analysis/analysis-cache'
import { MIN_TRUSTED_DEPTH } from '@/lib/analysis/review-depth'
import { api } from '@/lib/api'
import { scoreToWhitePerspective } from '@/lib/stockfish/eval'
import { STOCKFISH_ENGINE_ID, STOCKFISH_VERSION } from '@/lib/stockfish/version'
import { useEngineStore, type CachedEngineAnalysis } from '@/store/engine-store'

type EvalItem = {
  fen: string
  depth: number
  eval_cp: number | null
  eval_mate: number | null
  best_move_uci: string
  best_move_san: string
  pv_uci: string | null
  multipv_rank: number
  engine: string
  engine_version: string | null
}

const FLUSH_INTERVAL_MS = 3_000
const FLUSH_BATCH_SIZE = 50
const MAX_PENDING_ITEMS = 5_000

// Module-level pending queue survives re-renders but resets on HMR/page reload
const pendingItems = new Map<string, EvalItem>()
const collectedAnalyses = new WeakSet<CachedEngineAnalysis>()
let retryCount = 0
let retryAfter = 0
let isFlushing = false
// Set when a pass stopped at MAX_PENDING_ITEMS with analyses left uncollected.
// Only then does the timer scan the cache: every new result already arrives
// through the store subscription, and a full scan of up to 5,000 entries every
// 3s, hidden tab or not, found nothing new almost every time.
let collectionCut = false

function rejectedItemIndexes(error: unknown, batchSize: number): Set<number> {
  if (!isAxiosError(error) || error.response?.status !== 422) return new Set()
  const detail: unknown = error.response.data?.detail
  if (!Array.isArray(detail) || detail.length === 0) return new Set()
  const indexes = new Set<number>()
  for (const issue of detail) {
    const loc: unknown = issue?.loc
    // Only item-specific validation failures prove an entry is unusable.
    // Authentication, whole-request errors and unknown responses retain everything.
    if (
      !Array.isArray(loc) ||
      loc[0] !== 'body' ||
      loc[1] !== 'items' ||
      !Number.isInteger(loc[2]) ||
      loc[2] < 0 ||
      loc[2] >= batchSize
    )
      return new Set()
    indexes.add(loc[2])
  }
  return indexes
}

/**
 * The lines of a snapshot the server does not have yet. `persisted` speaks for
 * `lines`; the review-depth line a deeper board search displaced answers to
 * `reviewLinePersisted`. Reading `lines` alone, a game review of a position
 * the board had already searched deeper (and stored) uploaded nothing: the
 * snapshot read as persisted, and the review-depth row, the one a move is
 * graded from, never reached the library.
 */
function unsentLines(analysis: CachedEngineAnalysis) {
  const reviewLine =
    analysis.reviewLine && !analysis.reviewLinePersisted ? analysis.reviewLine : null
  const lines = analysis.persisted ? [] : [...analysis.lines]
  if (
    reviewLine &&
    !lines.some((line) => line.multipv === reviewLine.multipv && line.depth === reviewLine.depth)
  ) {
    lines.push(reviewLine)
  }
  return { lines, reviewLine }
}

function collectNewItems(): EvalItem[] {
  const { analysisByFen } = useEngineStore.getState()
  const newItems: EvalItem[] = []
  collectionCut = false

  for (const [fen, analysis] of Object.entries(analysisByFen)) {
    if (collectedAnalyses.has(analysis)) continue
    const { lines, reviewLine } = unsentLines(analysis)
    if (!lines.length) continue
    const engine = analysis.engine ?? STOCKFISH_ENGINE_ID
    if (engine !== STOCKFISH_ENGINE_ID) continue
    if (pendingItems.size + lines.length > MAX_PENDING_ITEMS) {
      collectionCut = true
      break
    }
    for (const line of lines) {
      // A look the player cut short by stepping on (depth 8, 12, ...) is fine
      // on the board and useless to the library: nothing is graded from below
      // the trust floor, so it was only ever storage and upload traffic.
      if (line.depth < MIN_TRUSTED_DEPTH) continue
      // Keep one pending result per position, rank and depth band; a deeper
      // search replaces unsent intermediate results in its own band instead of
      // generating another upload. The bands are apart because the server
      // stores a row per depth and grades a move only across depths its two
      // positions share: a depth-28 look at the board must not push the
      // unsent depth-20 review row out of the queue.
      const band = isReviewBandDepth(line.depth) ? 'review' : 'deep'
      const key = `${fen}|${engine}|${line.multipv}|${band}`
      if ((pendingItems.get(key)?.depth ?? 0) > line.depth) continue

      const score = scoreToWhitePerspective(line.score, fen)
      // `bestMove` belongs to the deeper search in `lines`, never to the kept
      // review line, which may have preferred another move.
      const bestMoveUci = line.pv[0] ?? (line === reviewLine ? '' : analysis.bestMove) ?? ''
      if (!bestMoveUci) continue

      const item: EvalItem = {
        fen,
        depth: line.depth,
        eval_cp: score.type === 'cp' ? score.value : null,
        eval_mate: score.type === 'mate' ? score.value : null,
        best_move_uci: bestMoveUci,
        best_move_san: '',
        pv_uci: line.pv.join(' '),
        multipv_rank: line.multipv,
        engine,
        engine_version: engine === STOCKFISH_ENGINE_ID ? STOCKFISH_VERSION : null,
      }

      newItems.push(item)
      pendingItems.set(key, item)
    }
    collectedAnalyses.add(analysis)
  }

  return newItems
}

async function flushPending(): Promise<void> {
  if (pendingItems.size === 0) return
  if (isFlushing) return
  if (Date.now() < retryAfter) return
  isFlushing = true

  try {
    while (pendingItems.size > 0) {
      const batch = Array.from(pendingItems.entries()).slice(0, FLUSH_BATCH_SIZE)
      const items = batch.map(([, item]) => item)

      try {
        await api.post('/api/analysis/evaluations', { items }, { timeout: 15_000 })
        for (const [key, item] of batch) {
          // A search may finish while the upload is in flight. Its newer
          // result must survive acknowledgement of this older batch.
          if (pendingItems.get(key) === item) pendingItems.delete(key)
        }
        retryCount = 0
        retryAfter = 0
      } catch (error) {
        const rejected = rejectedItemIndexes(error, batch.length)
        if (rejected.size > 0) {
          for (const index of rejected) {
            const [key, item] = batch[index]
            if (pendingItems.get(key) === item) pendingItems.delete(key)
          }
          console.warn('[chessgod] Eval sync skipped rejected entries', rejected.size)
          retryCount = 0
          retryAfter = 0
          continue
        }
        retryCount += 1
        retryAfter = Date.now() + Math.min(60_000, FLUSH_INTERVAL_MS * 2 ** Math.min(retryCount, 5))
        console.warn('[chessgod] Eval sync failed; keeping results for retry', error)
        return
      }
    }
  } finally {
    isFlushing = false
  }
}

export function useEngineEvalSync() {
  useEffect(() => {
    collectNewItems()
    // Background persistence does not need a React render for each position.
    return useEngineStore.subscribe((state, previous) => {
      if (state.analysisVersion === previous.analysisVersion) return
      collectNewItems()
      if (pendingItems.size >= FLUSH_BATCH_SIZE) void flushPending()
    })
  }, [])

  // Periodic flush timer
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (collectionCut) collectNewItems()
      void flushPending()
    }, FLUSH_INTERVAL_MS)

    return () => {
      window.clearInterval(timer)
    }
  }, [])

  // Flush on unmount — best-effort with sendBeacon fallback
  useEffect(() => {
    function handleBeforeUnload() {
      if (pendingItems.size === 0) return
      const items = Array.from(pendingItems.values()).slice(0, FLUSH_BATCH_SIZE)
      const blob = new Blob([JSON.stringify({ items })], { type: 'application/json' })
      navigator.sendBeacon(api.getUri({ url: '/api/analysis/evaluations' }), blob)
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      // Flush remaining on unmount
      void flushPending()
    }
  }, [])
}
