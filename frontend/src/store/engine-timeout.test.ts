import { afterEach, expect, it, vi } from 'vite-plus/test'

import type { EngineCallbacks } from '@/lib/stockfish/engine'
import { useEngineStore } from './engine-store'

const mock = vi.hoisted(() => ({
  callbacks: null as EngineCallbacks | null,
  analyze: vi.fn(),
  report: vi.fn(),
}))
vi.mock('@/lib/stockfish/engine', () => ({
  StockfishEngine: class {
    constructor(callbacks: EngineCallbacks) {
      mock.callbacks = callbacks
    }
    async init() {}
    analyze = mock.analyze
    stop() {}
  },
}))
vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry')>()),
  reportFrontendEvent: mock.report,
}))

afterEach(() => {
  useEngineStore.getState().stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('keeps what a deep look reached when it runs out of time', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
  useEngineStore.setState({ enabled: true, analysisByFen: {} })
  await useEngineStore.getState().analyzePosition(fen, { depth: 30, deep: true })
  await vi.advanceTimersByTimeAsync(100)
  expect(mock.analyze).toHaveBeenCalled()
  mock.callbacks!.onInfo({
    depth: 26,
    seldepth: null,
    multipv: 1,
    score: { type: 'cp', value: -25 },
    nodes: null,
    nps: null,
    time: null,
    pv: ['c7c5', 'g1f3'],
  })
  // Depth 30 never arrives; the position timeout fires.
  await vi.advanceTimersByTimeAsync(95_000)
  const stored = useEngineStore.getState().analysisByFen[fen]
  expect(stored?.depth).toBe(26)
  expect(stored?.bestMove).toBe('c7c5')
  expect(mock.report).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'engine_error' }))
})

it('stops a board search when nothing reads the board, keeping what it reached', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const fen = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -'
  useEngineStore.setState({ enabled: true, analysisByFen: {} })
  await useEngineStore.getState().analyzePosition(fen, { depth: 30, deep: true })
  await vi.advanceTimersByTimeAsync(100)
  mock.callbacks!.onInfo({
    depth: 19,
    seldepth: null,
    multipv: 1,
    score: { type: 'cp', value: 10 },
    nodes: null,
    nps: null,
    time: null,
    pv: ['d7d5', 'c2c4'],
  })
  await vi.advanceTimersByTimeAsync(50)

  useEngineStore.getState().stopInteractive()

  // Stopped at once rather than running on to its 90s timeout.
  expect(useEngineStore.getState().isAnalyzing).toBe(false)
  expect(useEngineStore.getState().analysisByFen[fen]?.depth).toBe(19)
})
