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

export class StockfishEngine {
  private worker: Worker | null = null
  private callbacks: EngineCallbacks
  private initStarted = false
  private initPromise: Promise<void> | null = null
  private lastAnalyzeKey: string | null = null

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
      this.callbacks.onError(event.message || 'Stockfish worker error.')
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

    if (event.line.startsWith('info depth')) {
      const info = parseUCIInfoLine(event.line)
      if (info) {
        this.callbacks.onInfo(info)
      }
      return
    }

    if (event.line.startsWith('bestmove')) {
      this.callbacks.onBestMove(event.line.split(' ')[1] || null)
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

    this.lastAnalyzeKey = analysisKey
    this.post({
      type: 'analyze',
      depth,
      fen,
      multiPV,
    })
  }

  stop() {
    this.post({ type: 'stop' })
  }

  destroy() {
    this.worker?.terminate()
    this.worker = null
    this.initStarted = false
    this.initPromise = null
    this.lastAnalyzeKey = null
  }
}
