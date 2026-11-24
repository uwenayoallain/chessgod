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
 * An engine the pool did not create and must not destroy: the board's own
 * engine, lent for the length of a review so its worker (wasm, the network and
 * its hash, already in memory) does the work of one more pool engine instead of
 * sitting idle beside it.
 */
export type BorrowedEngine = {
  engine: PoolEngine
  /**
   * The threads it searches with. They count against the pool's `size`, which
   * is a budget of single-threaded engines: a two-threaded engine stands in for
   * two of them, so lending it never puts more searches on the cores.
   */
  threads: number
  /**
   * Aborted when the owner needs the engine back before the review is over.
   * The search in hand stops, its position goes back to the pool, and the
   * threads it held are filled with engines of the pool's own.
   */
  revoke?: AbortSignal
  /**
   * Called exactly once, as soon as the pool is done with it. `healthy` is
   * false when a search on it had to be abandoned, so the owner rebuilds it
   * rather than trusting a worker that stopped answering.
   */
  release: (healthy: boolean) => void
}

type Slot = {
  engine: PoolEngine
  index: number
  borrowed: BorrowedEngine | null
  healthy: boolean
  revoked: boolean
  released: boolean
  /** Settles the search in hand when the slot is revoked. */
  cut: () => void
  cutting: Promise<null>
}

const REQUEUE = Symbol('requeue')

/**
 * Search every job across `size` engines, reporting each position as it
 * finishes. Resolves once every job has finished or the run was aborted; a
 * position whose search failed is reported with null.
 *
 * Engines come from `create` and go back through `retire` (by default
 * destroyed: a worker holds its own copy of the network, so an idle one keeps
 * hundreds of megabytes for nothing). `retire` is told whether the engine is
 * still sound, so a caller keeping engines warm between reviews (see
 * `createWarmPool`) never keeps one that stopped answering. A `borrow`ed engine
 * takes the first stretch of the game, only `size` minus its threads are
 * created beside it, and it is handed back through its own `release`, never
 * destroyed.
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
  retire = (engine) => engine.destroy(),
  borrow,
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
  retire?: (engine: PoolEngine, healthy: boolean) => void
  borrow?: BorrowedEngine | null
  hash: number
  signal: AbortSignal
  timeoutMs?: number
  movetimeMs?: number
  minDepth?: number
  priority?: () => ReviewJob | null
  onResult: (job: ReviewJob, lines: UCIInfo[] | null) => void
}) {
  // An engine asked back before the run even starts is returned untouched.
  let lent = borrow ?? null
  if (lent?.revoke?.aborted) {
    lent.release(true)
    lent = null
  }
  const budget = Math.max(1, size)
  const lentThreads = lent ? Math.min(budget, Math.max(1, Math.floor(lent.threads))) : 0
  const ownCount = lent
    ? Math.max(0, Math.min(budget - lentThreads, jobs.length - 1))
    : Math.max(1, Math.min(budget, jobs.length))

  // The run's own signal: the caller's abort, or a drain that failed.
  const run = new AbortController()
  const forwardAbort = () => run.abort()
  if (signal.aborted) run.abort()
  else signal.addEventListener('abort', forwardAbort, { once: true })

  const slots: Slot[] = []
  function addSlot(engine: PoolEngine, borrowed: BorrowedEngine | null) {
    let cut = () => {}
    const cutting = new Promise<null>((resolve) => {
      cut = () => resolve(null)
    })
    const slot: Slot = {
      engine,
      index: slots.length,
      borrowed,
      healthy: true,
      revoked: false,
      released: false,
      cut,
      cutting,
    }
    slots.push(slot)
    return slot
  }

  function releaseSlot(slot: Slot) {
    if (slot.released) return
    slot.released = true
    if (slot.borrowed) slot.borrowed.release(slot.healthy)
    else retire(slot.engine, slot.healthy)
  }

  // An engine already handed back may be searching for its owner now.
  const stopAll = () =>
    slots.forEach((slot) => {
      if (!slot.released && !slot.revoked) slot.engine.stop()
    })
  run.signal.addEventListener('abort', stopAll, { once: true })

  const lentSlot = lent ? addSlot(lent.engine, lent) : null
  for (let index = 0; index < ownCount; index += 1) addSlot(create(), null)
  const chunks = contiguousChunks(jobs, slots.length)

  const onRevoke = () => {
    if (!lentSlot || lentSlot.released || lentSlot.revoked) return
    lentSlot.revoked = true
    lentSlot.engine.stop()
    lentSlot.cut()
  }
  lent?.revoke?.addEventListener('abort', onRevoke, { once: true })

  /** One search, bounded by `timeoutMs`, the abort signal and a revoke. */
  async function search(slot: Slot, job: ReviewJob, movetime: number | undefined) {
    const { engine } = slot
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
        // still running on the worker. Either way it is not trusted again.
        if (engine.finish?.()) {
          grace = setTimeout(() => {
            slot.healthy = false
            engine.stop()
            resolve(null)
          }, 2_000)
          return
        }
        slot.healthy = false
        engine.stop()
        resolve(null)
      }, timeoutMs)
    })
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null)
      if (run.signal.aborted) resolve(null)
      else run.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([searching, timedOut, aborted, slot.cutting])
    } finally {
      clearTimeout(timer)
      clearTimeout(grace)
      // One listener per search used to stay on the signal for the whole run.
      if (onAbort) run.signal.removeEventListener('abort', onAbort)
    }
  }

  async function review(slot: Slot, job: ReviewJob) {
    const movetime = job.movetimeMs ?? movetimeMs
    const usable = (found: UCIInfo[] | null) =>
      Boolean(found?.length) && deepestDepth(found) >= Math.min(minDepth, job.depth)
    let lines = await search(slot, job, movetime)
    if (run.signal.aborted) return null
    if (!usable(lines) && !slot.revoked) {
      // Once more: a null is usually a search the worker dropped, and a
      // shallow one a position that needed longer than its share.
      const retry = await search(slot, job, movetime != null ? movetime * 2 : undefined)
      if (run.signal.aborted) return null
      lines = usable(retry) ? retry : deepestDepth(retry) > deepestDepth(lines) ? retry : lines
    }
    if (usable(lines)) return lines
    // Cut short because its owner took the engine back: another engine
    // searches it, rather than reporting a position as failed that never was.
    return slot.revoked ? REQUEUE : null
  }

  const drains: Promise<void>[] = []
  let failure: { error: unknown } | null = null

  async function drain(slot: Slot) {
    try {
      if (!slot.borrowed) await slot.engine.init({ hash, threads: 1 })
      while (!run.signal.aborted && !slot.revoked) {
        const job = priority?.() ?? takeJob(chunks, slot.index)
        if (!job) return
        const lines = await review(slot, job)
        if (run.signal.aborted) return
        if (lines === REQUEUE) {
          chunks[slot.index].push(job)
          break
        }
        onResult(job, lines)
      }
      if (slot.revoked && !run.signal.aborted) {
        // The threads the lent engine held go back to the pool as engines of
        // its own, so the review carries on at the same width.
        const left = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        for (let added = 0; added < Math.min(lentThreads, left); added += 1) {
          chunks.push([])
          launch(addSlot(create(), null))
        }
      }
    } finally {
      // A lent engine goes back the moment it is free, not when the last
      // engine of the pool is.
      if (slot.borrowed) releaseSlot(slot)
    }
  }

  function launch(slot: Slot) {
    drains.push(
      drain(slot).catch((error: unknown) => {
        failure ??= { error }
        run.abort()
      }),
    )
  }

  try {
    slots.forEach(launch)
    // Drains can be added while waiting (a revoked engine's replacements).
    for (let index = 0; index < drains.length; index += 1) await drains[index]
    if (failure) throw (failure as { error: unknown }).error
  } finally {
    signal.removeEventListener('abort', forwardAbort)
    run.signal.removeEventListener('abort', stopAll)
    lent?.revoke?.removeEventListener('abort', onRevoke)
    slots.forEach(releaseSlot)
  }
}

/**
 * Pool engines kept for a short while after a review, so the next one (another
 * game opened straight away, the same game asked again) starts on workers that
 * already hold the network instead of building each one again: a new worker
 * compiles the wasm and copies ~98MB of network into it before it can search.
 *
 * `acquire` hands out an idle engine or a new one; `release` takes one back,
 * keeping it for `idleMs` from the last engine returned, or destroying it when
 * it is not sound. `dropIdle` destroys the idle ones now. `reset` does that and
 * also marks every engine handed out so far for destruction on its return: it
 * is for when the engine is switched off or stopped while a pool may still be
 * settling, whose engines must not come back warm after it.
 */
export function createWarmPool<E extends PoolEngine>({
  create,
  idleMs,
}: {
  create: () => E
  idleMs: number
}) {
  let idle: E[] = []
  let epoch = 0
  const handedOut = new WeakMap<E, number>()
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer() {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function dropIdle() {
    clearTimer()
    const dropped = idle
    idle = []
    dropped.forEach((engine) => engine.destroy())
  }

  return {
    acquire(): E {
      const engine = idle.pop() ?? create()
      if (!idle.length) clearTimer()
      handedOut.set(engine, epoch)
      return engine
    },
    release(engine: E, healthy: boolean) {
      const current = handedOut.get(engine) === epoch
      handedOut.delete(engine)
      if (!healthy || !current) {
        engine.destroy()
        return
      }
      idle.push(engine)
      clearTimer()
      timer = setTimeout(dropIdle, idleMs)
    },
    dropIdle,
    reset() {
      epoch += 1
      dropIdle()
    },
    get idleCount() {
      return idle.length
    },
  }
}

export type WarmPool<E extends PoolEngine> = ReturnType<typeof createWarmPool<E>>
