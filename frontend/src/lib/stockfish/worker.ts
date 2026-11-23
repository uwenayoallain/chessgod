import type StockfishWeb from '@lichess-org/stockfish-web'

import { buildUciSearchCommands } from './analysis-policy'
import { getStockfishModuleUrl, getStockfishNnueUrl } from './asset-url'
import { fetchNnueBuffer, resolveNnueLoads } from './nnue'
import type { EngineWorkerCommand, EngineWorkerEvent, EngineWorkerStatus } from './protocol'

let stockfish: StockfishWeb | null = null
let initialized = false
let initPromise: Promise<void> | null = null
let initConfig: Extract<EngineWorkerCommand, { type: 'init' }> | null = null
type SearchCommand = Extract<EngineWorkerCommand, { type: 'analyze' }>

let pendingAnalysis: SearchCommand | null = null
let searchActive = false
let stoppingForPending = false
let activeSearchId: number | null = null
let latestSearchId: number | null = null

function send(event: EngineWorkerEvent) {
  self.postMessage(event)
}

function sendError(message: string) {
  send({ type: 'error', message })
}

function sendStatus(status: EngineWorkerStatus) {
  send({ type: 'status', status })
}

async function loadNnueAtIndex(engine: StockfishWeb, index: number, filename: string) {
  const url = getStockfishNnueUrl(self.location.origin, filename)
  engine.setNnueBuffer(await fetchNnueBuffer(url, filename), index)
}

async function loadRecommendedNnue(engine: StockfishWeb) {
  const loads = resolveNnueLoads((index) => engine.getRecommendedNnue(index))
  if (loads.length === 0) {
    throw new Error('The analysis model could not be loaded.')
  }

  for (const { index, filename } of loads) {
    await loadNnueAtIndex(engine, index, filename)
  }
}

function startAnalysis(command: SearchCommand) {
  if (!stockfish) return
  activeSearchId = command.searchId
  searchActive = true

  for (const uciCommand of buildUciSearchCommands({
    depth: command.depth,
    fen: command.fen,
    multiPV: command.multiPV,
  })) {
    stockfish.uci(uciCommand)
  }
}

function attachListeners(engine: StockfishWeb) {
  engine.listen = (line) => {
    const lineSearchId = activeSearchId
    if (line.startsWith('bestmove')) {
      searchActive = false
      activeSearchId = null
      if (stoppingForPending && pendingAnalysis) {
        const nextAnalysis = pendingAnalysis
        pendingAnalysis = null
        stoppingForPending = false
        startAnalysis(nextAnalysis)
        return
      }
      stoppingForPending = false
    }

    send({ type: 'line', line, searchId: lineSearchId })

    if (line === 'uciok') {
      if (initConfig) {
        engine.uci(`setoption name Threads value ${initConfig.threads}`)
        engine.uci(`setoption name Hash value ${initConfig.hash}`)
      }
      engine.uci('setoption name UCI_AnalyseMode value true')
      engine.uci('isready')
      return
    }

    if (line === 'readyok') {
      initialized = true
      sendStatus('ready')
      if (!searchActive && pendingAnalysis) {
        const nextAnalysis = pendingAnalysis
        pendingAnalysis = null
        startAnalysis(nextAnalysis)
      }
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
      engine.uci('uci')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to initialize analysis.'
      initPromise = null
      initialized = false
      stockfish = null
      pendingAnalysis = null
      searchActive = false
      stoppingForPending = false
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

async function onAnalyze(command: SearchCommand) {
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

  if (command.searchId !== latestSearchId) return

  if (!stockfish) {
    sendError('Engine not initialized.')
    return
  }

  if (!initialized) {
    pendingAnalysis = command
    return
  }

  if (searchActive) {
    pendingAnalysis = command
    stoppingForPending = true
    stockfish.uci('stop')
    return
  }

  startAnalysis(command)
}

function onStop() {
  latestSearchId = null
  pendingAnalysis = null
  stoppingForPending = false
  stockfish?.uci('stop')
}

self.onmessage = (event: MessageEvent<EngineWorkerCommand>) => {
  const command = event.data

  if (command.type === 'init') {
    void onInit(command)
    return
  }

  if (command.type === 'analyze') {
    latestSearchId = command.searchId
    void onAnalyze(command)
    return
  }

  onStop()
}
