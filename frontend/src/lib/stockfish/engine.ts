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
        resolve(
          parseBestMove(event.line)
            ? [...lines.values()].sort((a, b) => a.multipv - b.multipv)
            : null,
        )
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
      this.post({
        type: 'init',
        hash,
        threads,
      })
    })

    return this.initPromise
  }

  analyze(fen: string, options: AnalyzeOptions = {}) {
    const depth = options.depth ?? 18
    const multiPV = options.multiPV ?? 3
    const analysisKey = `${fen}|${depth}|${multiPV}`

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
    })
  }

  /**
   * Search `fen` for a move to play: `multiPV` candidate lines to `depth`, at
   * full strength. Resolves with the final line per candidate, or null when
   * there is no move or the search was superseded (a stop, or a newer search
   * on the shared worker). Choosing among them is the caller's business.
   */
  play(fen: string, { depth, multiPV }: { depth: number; multiPV: number }) {
    this.cancelPlay()
    this.activeSearchId = null
    this.lastAnalyzeKey = null
    const searchId = ++this.nextSearchId
    return new Promise<UCIInfo[] | null>((resolve) => {
      this.pendingPlay = { searchId, lines: new Map(), resolve }
      this.post({ type: 'analyze', searchId, fen, depth, multiPV })
    })
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
