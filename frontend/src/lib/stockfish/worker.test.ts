import { afterEach, expect, it, vi } from 'vite-plus/test'

import type { EngineWorkerCommand, EngineWorkerEvent } from './protocol'

const { fakeEngine } = vi.hoisted(() => ({
  fakeEngine: {
    listen: (_line: string) => {},
    onError: (_message: string) => {},
    uci: vi.fn(),
    getRecommendedNnue: (index: number) => (index === 0 ? 'nn-039058c6f2c0.nnue' : ''),
    setNnueBuffer: vi.fn(),
  },
}))

vi.mock('./asset-url', () => ({
  getStockfishModuleUrl: () => '@lichess-org/stockfish-web',
  getStockfishNnueUrl: () => 'http://localhost/stockfish/nn-039058c6f2c0.nnue',
}))
vi.mock('@lichess-org/stockfish-web', () => ({ default: async () => fakeEngine }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

it('waits for stopped-search completion and tags old and new lines with their own search IDs', async () => {
  const events: EngineWorkerEvent[] = []
  const scope = {
    location: { origin: 'http://localhost' },
    postMessage: (event: EngineWorkerEvent) => events.push(event),
    onmessage: (_event: { data: EngineWorkerCommand }) => {},
  }
  vi.stubGlobal('self', scope)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))))
  await import('./worker')
  const send = (data: EngineWorkerCommand) => scope.onmessage({ data })
  send({ type: 'init', threads: 1, hash: 16 })
  await vi.waitFor(() => expect(fakeEngine.uci).toHaveBeenCalledWith('uci'))
  fakeEngine.listen('uciok')
  fakeEngine.listen('readyok')
  events.length = 0
  send({ type: 'analyze', searchId: 1, fen: 'first', depth: 22, multiPV: 1 })
  fakeEngine.listen('info depth 18 score cp 10 pv e2e4')
  send({ type: 'analyze', searchId: 2, fen: 'second', depth: 22, multiPV: 1 })
  fakeEngine.listen('info depth 19 score cp 20 pv e2e4')
  expect(fakeEngine.uci).not.toHaveBeenCalledWith('position fen second')
  fakeEngine.listen('bestmove e2e4')
  expect(fakeEngine.uci).toHaveBeenCalledWith('position fen second')
  fakeEngine.listen('info depth 20 score cp 30 pv d2d4')
  fakeEngine.listen('bestmove d2d4')
  expect(events.filter((event) => event.type === 'line')).toEqual([
    { type: 'line', searchId: 1, line: 'info depth 18 score cp 10 pv e2e4' },
    { type: 'line', searchId: 1, line: 'info depth 19 score cp 20 pv e2e4' },
    { type: 'line', searchId: 2, line: 'info depth 20 score cp 30 pv d2d4' },
    { type: 'line', searchId: 2, line: 'bestmove d2d4' },
  ])
})

it('does not launch a pending search that was cancelled during model initialization', async () => {
  let finishFetch!: (response: Response) => void
  const scope = {
    location: { origin: 'http://localhost' },
    postMessage: vi.fn(),
    onmessage: (_event: { data: EngineWorkerCommand }) => {},
  }
  vi.stubGlobal('self', scope)
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishFetch = resolve
        }),
    ),
  )
  await import('./worker')
  scope.onmessage({ data: { type: 'init', threads: 1, hash: 16 } })
  scope.onmessage({
    data: { type: 'analyze', searchId: 1, fen: 'cancelled', depth: 22, multiPV: 1 },
  })
  scope.onmessage({ data: { type: 'stop' } })
  await vi.waitFor(() => expect(finishFetch).toBeDefined())
  finishFetch(new Response(new Uint8Array([1, 2, 3])))
  await vi.waitFor(() => expect(fakeEngine.uci).toHaveBeenCalledWith('uci'))
  expect(fakeEngine.uci).not.toHaveBeenCalledWith('position fen cancelled')
})

it('defers analyze commands until the handshake completes after readyok', async () => {
  let finishFetch!: (response: Response) => void
  const events: EngineWorkerEvent[] = []
  const scope = {
    location: { origin: 'http://localhost' },
    postMessage: (event: EngineWorkerEvent) => events.push(event),
    onmessage: (_event: { data: EngineWorkerCommand }) => {},
  }
  vi.stubGlobal('self', scope)
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishFetch = resolve
        }),
    ),
  )
  await import('./worker')
  const send = (data: EngineWorkerCommand) => scope.onmessage({ data })
  send({ type: 'init', threads: 2, hash: 32 })
  send({ type: 'analyze', searchId: 7, fen: 'queued', depth: 20, multiPV: 2 })
  await vi.waitFor(() => expect(finishFetch).toBeDefined())
  finishFetch(new Response(new Uint8Array([1, 2, 3])))
  await vi.waitFor(() => expect(fakeEngine.uci).toHaveBeenCalledWith('uci'))
  expect(fakeEngine.uci).not.toHaveBeenCalledWith('position fen queued')
  fakeEngine.listen('uciok')
  expect(fakeEngine.uci).toHaveBeenCalledWith('setoption name Threads value 2')
  expect(fakeEngine.uci).toHaveBeenCalledWith('setoption name Hash value 32')
  expect(fakeEngine.uci).toHaveBeenCalledWith('setoption name UCI_AnalyseMode value true')
  expect(fakeEngine.uci).toHaveBeenCalledWith('isready')
  expect(fakeEngine.uci).not.toHaveBeenCalledWith('position fen queued')
  fakeEngine.listen('readyok')
  expect(fakeEngine.uci).toHaveBeenCalledWith('setoption name MultiPV value 2')
  expect(fakeEngine.uci).toHaveBeenCalledWith('position fen queued')
  expect(fakeEngine.uci).toHaveBeenCalledWith('go depth 20')
  expect(events.some((event) => event.type === 'status' && event.status === 'ready')).toBe(true)
})

it('cancels a search requested before readyok when a stop arrives during the handshake', async () => {
  let finishFetch!: (response: Response) => void
  const scope = {
    location: { origin: 'http://localhost' },
    postMessage: vi.fn(),
    onmessage: (_event: { data: EngineWorkerCommand }) => {},
  }
  vi.stubGlobal('self', scope)
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishFetch = resolve
        }),
    ),
  )
  await import('./worker')
  scope.onmessage({ data: { type: 'init', threads: 1, hash: 16 } })
  scope.onmessage({
    data: { type: 'analyze', searchId: 3, fen: 'cancelled', depth: 20, multiPV: 1 },
  })
  scope.onmessage({ data: { type: 'stop' } })
  await vi.waitFor(() => expect(finishFetch).toBeDefined())
  finishFetch(new Response(new Uint8Array([1, 2, 3])))
  await vi.waitFor(() => expect(fakeEngine.uci).toHaveBeenCalledWith('uci'))
  fakeEngine.listen('uciok')
  fakeEngine.listen('readyok')
  expect(fakeEngine.uci).not.toHaveBeenCalledWith('position fen cancelled')
  expect(fakeEngine.uci).not.toHaveBeenCalledWith('go depth 20')
})
