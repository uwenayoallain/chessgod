import type { EngineWorkerCommand, EngineWorkerEvent, EngineWorkerStatus } from './protocol'
import { parseUCIInfoLine, type UCIInfo } from './uci'

export type EngineCallbacks = {
  onInfo: (info: UCIInfo) => void
  onBestMove: (move: string | null) => void
  onReady: () => void
  onStatus: (status: EngineWorkerStatus) => void
  onError: (message: string) => void
}

type AnalyzeOptions = {
  depth?: number
  multiPV?: number
  force?: boolean
  /** Stop after this many milliseconds even if `depth` is not reached. */
  movetime?: number
}

export type PlayOptions = { depth: number; multiPV: number; movetime?: number }

/**
 * The lines of the last depth the search reached, in rank order.
 *
 * With MultiPV, an iteration reports its lines one at a time, and a search that
 * stops mid-iteration (a time limit, a stop) leaves some ranks at the new depth
 * and the rest at the one before. Choosing among them compares a move searched
 * a ply deeper against one that was not, which is how a shallow line with a
 * stale score could be picked over a sound one. Only lines searched as deep as
 * the deepest belong to the same comparison.
 */
export function deepestLines(lines: Iterable<UCIInfo>): UCIInfo[] {
  const all = [...lines]
  const deepest = all.reduce((max, line) => Math.max(max, line.depth), 0)
  return all.filter((line) => line.depth === deepest).sort((a, b) => a.multipv - b.multipv)
}

function parseBestMove(line: string): string | null {
  const move = line.split(' ')[1]
  return !move || move === '(none)' || move === '0000' ? null : move
}

export class StockfishEngine {
  private worker: Worker | null = null
  private callbacks: EngineCallbacks
  private initStarted = false
  private initPromise: Promise<void> | null = null
  private lastAnalyzeKey: string | null = null
  private nextSearchId = 0
  private activeSearchId: number | null = null
  // A search whose lines go to a caller choosing a move to *play*, not to the
  // analysis callbacks: a sparring search is shallow by design, so it must
  // never be cached or uploaded as an evaluation.
  private pendingPlay: {
    searchId: number
    lines: Map<number, UCIInfo>
    resolve: (lines: UCIInfo[] | null) => void
  } | null = null

  constructor(callbacks: EngineCallbacks) {
    this.callbacks = callbacks
  }

  private ensureWorker() {
    if (this.worker) {
      return this.worker
    }

    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<EngineWorkerEvent>) => {
      this.handleWorkerEvent(event.data)
    }
    this.worker.onerror = (event) => {
      event.preventDefault()
      this.callbacks.onError(event.message || 'Analysis worker error.')
    }

    return this.worker
  }

  private post(command: EngineWorkerCommand) {
    this.ensureWorker().postMessage(command)
  }

  private handleWorkerEvent(event: EngineWorkerEvent) {
    if (event.type === 'error') {
      this.callbacks.onError(event.message)
      return
    }

    if (event.type === 'status') {
      this.callbacks.onStatus(event.status)
      if (event.status === 'ready') {
        this.callbacks.onReady()
      }
      return
    }

    if (this.pendingPlay && event.searchId === this.pendingPlay.searchId) {
      if (event.line.startsWith('info depth')) {
        const info = parseUCIInfoLine(event.line)
        if (info) this.pendingPlay.lines.set(info.multipv, info)
        return
      }
      if (event.line.startsWith('bestmove')) {
        const { lines, resolve } = this.pendingPlay
        this.pendingPlay = null
        resolve(parseBestMove(event.line) ? deepestLines(lines.values()) : null)
      }
      return
    }

    if (this.activeSearchId === null || event.searchId !== this.activeSearchId) return

    if (event.line.startsWith('info depth')) {
      const info = parseUCIInfoLine(event.line)
      if (info) {
        this.callbacks.onInfo(info)
      }
      return
    }

    if (event.line.startsWith('bestmove')) {
      this.activeSearchId = null
      this.lastAnalyzeKey = null
      this.callbacks.onBestMove(parseBestMove(event.line))
    }
  }

  init({ hash, threads }: { hash: number; threads: number }) {
    if (this.initStarted && this.initPromise) {
      return this.initPromise
    }

    this.initStarted = true
    this.initPromise = Promise.resolve().then(() => {
      try {
        this.post({
          type: 'init',
          hash,
          threads,
        })
      } catch (error) {
        // The worker could not be created at all: no `Worker` outside a
        // browser, or a module worker refused. A thrown constructor is the
        // engine failing like any other error, so it goes through `onError`
        // and the promise settles, instead of an unhandled rejection every
        // caller of `init()` would have to catch. The flag resets so a later
        // `init()` tries again rather than returning this failure forever.
        this.initStarted = false
        this.initPromise = null
        this.callbacks.onError(error instanceof Error ? error.message : String(error))
      }
    })

    return this.initPromise
  }

  analyze(fen: string, options: AnalyzeOptions = {}) {
    const depth = options.depth ?? 18
    const multiPV = options.multiPV ?? 3
    const movetime = options.movetime
    const analysisKey = `${fen}|${depth}|${multiPV}|${movetime ?? ''}`

    if (!options.force && this.lastAnalyzeKey === analysisKey) {
      return
    }

    // The worker swallows the bestmove of a search it stops for a newer one,
    // so a superseded play would otherwise never settle.
    this.cancelPlay()
    this.lastAnalyzeKey = analysisKey
    this.activeSearchId = ++this.nextSearchId
    this.post({
      type: 'analyze',
      searchId: this.activeSearchId,
      depth,
      fen,
      multiPV,
      ...(movetime != null ? { movetime } : {}),
    })
  }

  /**
   * Search `fen` for a move to play: `multiPV` candidate lines to `depth`, at
   * full strength, or for `movetime` milliseconds if that comes first.
   * Resolves with the lines of the deepest depth reached, one per candidate,
   * or null when there is no move or the search was superseded (a stop, or a
   * newer search on the shared worker). Choosing among them is the caller's
   * business.
   */
  play(fen: string, { depth, multiPV, movetime }: PlayOptions) {
    this.cancelPlay()
    this.activeSearchId = null
    this.lastAnalyzeKey = null
    const searchId = ++this.nextSearchId
    return new Promise<UCIInfo[] | null>((resolve) => {
      this.pendingPlay = { searchId, lines: new Map(), resolve }
      this.post({
        type: 'analyze',
        searchId,
        fen,
        depth,
        multiPV,
        ...(movetime != null ? { movetime } : {}),
      })
    })
  }

  /**
   * End the pending `play` search early and keep what it reached: the engine
   * is told to stop, and the search settles on the `bestmove` that follows,
   * with its lines, as a finished one would. `stop` instead settles it with
   * nothing. Returns false when there was no search to finish.
   */
  finish() {
    if (!this.pendingPlay || !this.worker) return false
    this.worker.postMessage({ type: 'stop' } satisfies EngineWorkerCommand)
    return true
  }

  private cancelPlay() {
    if (!this.pendingPlay) return
    const { resolve } = this.pendingPlay
    this.pendingPlay = null
    resolve(null)
  }

  stop() {
    this.cancelPlay()
    this.activeSearchId = null
    this.lastAnalyzeKey = null
    this.worker?.postMessage({ type: 'stop' } satisfies EngineWorkerCommand)
  }

  destroy() {
    this.cancelPlay()
    this.worker?.terminate()
    this.worker = null
    this.initStarted = false
    this.initPromise = null
    this.lastAnalyzeKey = null
    this.activeSearchId = null
  }
}
