import type { UCIInfo } from './uci'

/** What the pool needs from an engine: the same `play` search the sparring opponent uses. */
export type PoolEngine = {
  init: (options: { hash: number; threads: number }) => Promise<void> | void
  play: (fen: string, options: { depth: number; multiPV: number }) => Promise<UCIInfo[] | null>
  stop: () => void
  destroy: () => void
}

export type ReviewJob = { fen: string; depth: number }

/**
 * How many single-threaded engines review a game at once.
 *
 * A game's positions are independent, so they are searched side by side rather
 * than one after another on one many-threaded engine: measured on this build,
 * Stockfish's parallel search shares one tree and scales badly, while separate
 * engines scale almost linearly up to the physical cores. One core is left for
 * the page and the live engine.
 */
export function reviewPoolSize(hardwareConcurrency?: number) {
  const cores =
    hardwareConcurrency ??
    (typeof navigator === 'undefined' ? 2 : (navigator.hardwareConcurrency ?? 2))
  return Math.max(1, Math.min(4, Math.floor(cores / 2)))
}

/**
 * Search every job across `size` engines, reporting each position as it
 * finishes. Engines are created for the run and destroyed after it: a
 * worker holds its own copy of the network, so an idle pool would keep
 * hundreds of megabytes for nothing. Resolves once every job has finished or
 * the run was aborted; a position whose search failed is reported with null.
 */
export async function runReviewPool({
  jobs,
  size,
  create,
  hash,
  signal,
  timeoutMs = 60_000,
  onResult,
}: {
  jobs: ReviewJob[]
  size: number
  create: () => PoolEngine
  hash: number
  signal: AbortSignal
  timeoutMs?: number
  onResult: (job: ReviewJob, lines: UCIInfo[] | null) => void
}) {
  const engines = Array.from({ length: Math.max(1, Math.min(size, jobs.length)) }, create)
  const stopAll = () => engines.forEach((engine) => engine.stop())
  signal.addEventListener('abort', stopAll)
  let next = 0

  async function drain(engine: PoolEngine) {
    await engine.init({ hash, threads: 1 })
    while (!signal.aborted && next < jobs.length) {
      const job = jobs[next++]
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          // Stopping settles the pending search with nothing; never abandon
          // a search that is still running on the worker.
          engine.stop()
          resolve(null)
        }, timeoutMs)
      })
      const aborted = new Promise<null>((resolve) =>
        signal.addEventListener('abort', () => resolve(null), { once: true }),
      )
      const lines = await Promise.race([
        engine.play(job.fen, { depth: job.depth, multiPV: 1 }),
        timedOut,
        aborted,
      ])
      clearTimeout(timer)
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
