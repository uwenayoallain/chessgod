import { MIN_TRUSTED_DEPTH } from '@/lib/analysis/review-depth'

import type { PlayOptions } from './engine'
import type { UCIInfo } from './uci'

/** What the pool needs from an engine: the same `play` search the sparring opponent uses. */
export type PoolEngine = {
  init: (options: { hash: number; threads: number }) => Promise<void> | void
  play: (fen: string, options: PlayOptions) => Promise<UCIInfo[] | null>
  /**
   * Stop the search in hand and settle it with what it reached. Optional:
   * without it a search that overruns is stopped and given up.
   */
  finish?: () => boolean
  stop: () => void
  destroy: () => void
}

export type ReviewJob = {
  fen: string
  depth: number
  /** This position's time limit; the pool's `movetimeMs` when absent. */
  movetimeMs?: number
  /** Candidate lines to search; one when absent, as a review grades one move. */
  multiPV?: number
}

/** One engine's working memory, measured: wasm, the net and a small hash. */
const ENGINE_MEMORY_GB = 0.5

/**
 * How many single-threaded engines review a game at once.
 *
 * A game's positions are independent, so they are searched side by side rather
 * than one after another on one many-threaded engine: measured on this build,
 * Stockfish's parallel search shares one tree and scales badly, while separate
 * engines scale almost linearly up to the physical cores.
 *
 * At most three. Four engines on an 8-thread laptop (4 physical cores) filled
 * every physical core, so the page, the browser and the machine's owner
 * competed with the review for the rest, and the package heat-soaked into
 * throttling, which slows every core at once. Three leaves a core free. Each
 * engine also holds its own copy of the network (~450MB), so a device that
 * reports little memory gets fewer: `deviceMemory` is capped at 8 by Chrome and
 * absent elsewhere, so it can only ever lower the count, never raise it.
 */
export function reviewPoolSize(hardwareConcurrency?: number, deviceMemoryGb?: number) {
  const nav =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { deviceMemory?: number })
  const cores = hardwareConcurrency ?? nav?.hardwareConcurrency ?? 2
  const memory = deviceMemoryGb ?? nav?.deviceMemory
  const byCores = Math.min(3, Math.floor(cores / 2))
  // Leave half the reported memory to the page and the rest of the browser.
  const byMemory =
    memory != null && memory > 0 ? Math.floor(memory / 2 / ENGINE_MEMORY_GB) : byCores
  return Math.max(1, Math.min(byCores, byMemory))
}

/**
 * Split the jobs into `count` contiguous stretches of the game.
 *
 * Contiguous, because neighbouring positions share most of their search: an
 * engine that has just searched a position has the next one's subtree in its
 * hash already.
 */
export function contiguousChunks<T>(jobs: T[], count: number): T[][] {
  const chunks: T[][] = []
  const size = Math.max(1, count)
  let start = 0
  for (let index = 0; index < size; index += 1) {
    const length = Math.floor(jobs.length / size) + (index < jobs.length % size ? 1 : 0)
    chunks.push(jobs.slice(start, start + length))
    start += length
  }
  return chunks
}

/**
 * The next position for engine `index`: the last of its own stretch, so each
 * engine walks its part of the game backwards (endgame, then middlegame, then
 * opening). Searching a child before its parent leaves the child's lines in the
 * hash table, and the parent's search, which has to look at that child
 * anyway, starts from them. Once its own stretch is done an engine takes from
 * the end of whichever stretch has the most left, so nobody idles while
 * another still has a queue.
 */
export function takeJob<T>(chunks: T[][], index: number): T | undefined {
  const own = chunks[index]
  if (own?.length) return own.pop()
  let victim = -1
  for (let other = 0; other < chunks.length; other += 1) {
    if (chunks[other].length && (victim < 0 || chunks[other].length > chunks[victim].length)) {
      victim = other
    }
  }
  return victim < 0 ? undefined : chunks[victim].pop()
}

function deepestDepth(lines: UCIInfo[] | null) {
  return lines?.reduce((max, line) => Math.max(max, line.depth), 0) ?? 0
}

/**
 * Search every job across `size` engines, reporting each position as it
 * finishes. Engines are created for the run and destroyed after it: a
 * worker holds its own copy of the network, so an idle pool would keep
 * hundreds of megabytes for nothing. Resolves once every job has finished or
 * the run was aborted; a position whose search failed is reported with null.
 *
 * Each search stops at its time limit (`movetimeMs`) even short of its depth,
 * so one sharp position cannot hold an engine for a minute while the rest of
 * the game waits. What it reached is kept when it is deep enough to grade a
 * move from (`minDepth`); a search that came back with nothing, or too
 * shallow, is tried once more, the shallow one with twice the time.
 * `timeoutMs` is the hard limit on any one search, for an engine that has
 * stopped answering.
 *
 * `priority` is asked for a job each time an engine comes free, before it
 * takes the next position of its own stretch: a position the player has just
 * stepped onto is searched by the next warm engine rather than after the
 * whole game. It returns null when there is nothing more urgent.
 */
export async function runReviewPool({
  jobs,
  size,
  create,
  hash,
  signal,
  timeoutMs = 60_000,
  movetimeMs,
  minDepth = MIN_TRUSTED_DEPTH,
  priority,
  onResult,
}: {
  jobs: ReviewJob[]
  size: number
  create: () => PoolEngine
  hash: number
  signal: AbortSignal
  timeoutMs?: number
  movetimeMs?: number
  minDepth?: number
  priority?: () => ReviewJob | null
  onResult: (job: ReviewJob, lines: UCIInfo[] | null) => void
}) {
  const engines = Array.from({ length: Math.max(1, Math.min(size, jobs.length)) }, create)
  const stopAll = () => engines.forEach((engine) => engine.stop())
  signal.addEventListener('abort', stopAll)
  const chunks = contiguousChunks(jobs, engines.length)

  /** One search, bounded by `timeoutMs` and the abort signal. */
  async function search(engine: PoolEngine, job: ReviewJob, movetime: number | undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let grace: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const searching = engine.play(job.fen, {
      depth: job.depth,
      multiPV: job.multiPV ?? 1,
      ...(movetime != null ? { movetime } : {}),
    })
    const timedOut = new Promise<UCIInfo[] | null>((resolve) => {
      timer = setTimeout(() => {
        // Ask the engine to stop and keep what it reached; its `bestmove`
        // settles `searching` with those lines. An engine that does not even
        // answer that is stopped outright: never abandon a search that is
        // still running on the worker.
        if (engine.finish?.()) {
          grace = setTimeout(() => {
            engine.stop()
            resolve(null)
          }, 2_000)
          return
        }
        engine.stop()
        resolve(null)
      }, timeoutMs)
    })
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null)
      if (signal.aborted) resolve(null)
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([searching, timedOut, aborted])
    } finally {
      clearTimeout(timer)
      clearTimeout(grace)
      // One listener per search used to stay on the signal for the whole run.
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  async function review(engine: PoolEngine, job: ReviewJob) {
    const movetime = job.movetimeMs ?? movetimeMs
    let lines = await search(engine, job, movetime)
    if (signal.aborted) return null
    const usable = (found: UCIInfo[] | null) =>
      Boolean(found?.length) && deepestDepth(found) >= Math.min(minDepth, job.depth)
    if (!usable(lines)) {
      // Once more: a null is usually a search the worker dropped, and a
      // shallow one a position that needed longer than its share.
      const retry = await search(engine, job, movetime != null ? movetime * 2 : undefined)
      if (signal.aborted) return null
      lines = usable(retry) ? retry : deepestDepth(retry) > deepestDepth(lines) ? retry : lines
    }
    return usable(lines) ? lines : null
  }

  async function drain(engine: PoolEngine, index: number) {
    await engine.init({ hash, threads: 1 })
    while (!signal.aborted) {
      const job = priority?.() ?? takeJob(chunks, index)
      if (!job) return
      const lines = await review(engine, job)
      if (signal.aborted) return
      onResult(job, lines)
    }
  }

  try {
    await Promise.all(engines.map(drain))
  } finally {
    signal.removeEventListener('abort', stopAll)
    engines.forEach((engine) => engine.destroy())
  }
}
