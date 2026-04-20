import type StockfishWeb from '@lichess-org/stockfish-web'

import { getStockfishModuleUrl, getStockfishNnueUrl } from './asset-url'
import type { EngineWorkerCommand, EngineWorkerEvent, EngineWorkerStatus } from './protocol'

let stockfish: StockfishWeb | null = null
let initialized = false
let ready = false
let initPromise: Promise<void> | null = null
let pendingAnalysis: Extract<EngineWorkerCommand, { type: 'analyze' }> | null = null
let initConfig: Extract<EngineWorkerCommand, { type: 'init' }> | null = null

function send(event: EngineWorkerEvent) {
  self.postMessage(event)
}

function sendError(message: string) {
  send({ type: 'error', message })
}

function sendStatus(status: EngineWorkerStatus) {
  send({ type: 'status', status })
}

async function loadRecommendedNnue(engine: StockfishWeb) {
  const filename = engine.getRecommendedNnue(0)
  const response = await fetch(getStockfishNnueUrl(self.location.origin, filename))

  if (!response.ok) {
    throw new Error(`Failed to load NNUE: ${response.status}`)
  }

  engine.setNnueBuffer(new Uint8Array(await response.arrayBuffer()), 0)
}

function runPendingAnalysis() {
  if (!stockfish || !pendingAnalysis) {
    return
  }

  const nextAnalysis = pendingAnalysis
  pendingAnalysis = null

  stockfish.uci(`position fen ${nextAnalysis.fen}`)
  stockfish.uci(`go depth ${nextAnalysis.depth}`)
}

function attachListeners(engine: StockfishWeb) {
  engine.listen = (line) => {
    send({ type: 'line', line })

    if (line === 'uciok') {
      if (initConfig) {
        engine.uci(`setoption name Threads value ${initConfig.threads}`)
        engine.uci(`setoption name Hash value ${initConfig.hash}`)
      }
      engine.uci('isready')
      return
    }

    if (line === 'readyok') {
      ready = true
      sendStatus('ready')
      runPendingAnalysis()
    }
  }

  engine.onError = (message) => {
    sendError(message)
  }
}

async function initializeEngine(config: Extract<EngineWorkerCommand, { type: 'init' }>) {
  if (initialized) {
    return
  }

  if (initPromise) {
    return initPromise
  }

  initConfig = config
  initPromise = (async () => {
    try {
      sendStatus('initializing')
      const moduleUrl = getStockfishModuleUrl(self.location.origin)
      const { default: createStockfish } = await import(
        /* @vite-ignore */
        moduleUrl
      )
      const engine = await createStockfish()

      attachListeners(engine)

      sendStatus('nnue-loading')
      await loadRecommendedNnue(engine)
      sendStatus('nnue-loaded')

      stockfish = engine
      initialized = true
      engine.uci('uci')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to initialize Stockfish.'
      initPromise = null
      initialized = false
      ready = false
      stockfish = null
      sendError(message)
      throw error
    }
  })()

  return initPromise
}

async function onInit(command: Extract<EngineWorkerCommand, { type: 'init' }>) {
  try {
    await initializeEngine(command)
  } catch {}
}

async function onAnalyze(command: Extract<EngineWorkerCommand, { type: 'analyze' }>) {
  if (!stockfish) {
    if (!initConfig) {
      sendError('Engine not initialized.')
      return
    }

    try {
      await initializeEngine(initConfig)
    } catch {
      return
    }
  }

  if (!stockfish) {
    sendError('Engine not initialized.')
    return
  }

  ready = false
  pendingAnalysis = command
  stockfish.uci('stop')
  stockfish.uci(`setoption name MultiPV value ${command.multiPV}`)
  stockfish.uci('isready')
}

function onStop() {
  pendingAnalysis = null
  stockfish?.uci('stop')
}

self.onmessage = (event: MessageEvent<EngineWorkerCommand>) => {
  const command = event.data

  if (command.type === 'init') {
    void onInit(command)
    return
  }

  if (command.type === 'analyze') {
    void onAnalyze(command)
    return
  }

  onStop()
}
