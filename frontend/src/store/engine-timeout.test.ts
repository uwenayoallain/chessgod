import { afterEach, expect, it, vi } from 'vite-plus/test'

import type { EngineCallbacks } from '@/lib/stockfish/engine'
import { useAppStore } from './app-store'
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

function info(depth: number, multipv: number, pv: string[], value = 10) {
  return {
    depth,
    seldepth: null,
    multipv,
    score: { type: 'cp' as const, value },
    nodes: null,
    nps: null,
    time: null,
    pv,
  }
}

it('runs one search per position, with two lines and a time limit', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  mock.analyze.mockClear()
  const fen = 'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq -'
  useEngineStore.setState({ enabled: true, analysisByFen: {} })
  await useEngineStore.getState().analyzePosition(fen, { depth: 26 })
  await vi.advanceTimersByTimeAsync(2_000)
  // No shallow single-line pass first, and no restart from depth 1 after it.
  expect(mock.analyze).toHaveBeenCalledExactlyOnceWith(fen, {
    depth: 26,
    multiPV: 2,
    force: true,
    movetime: 12_000,
  })
})

it('keeps the known lines on the board until a refining search goes as deep', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  const frames: Array<() => void> = []
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const fen = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -'
  useAppStore.setState({ currentFen: fen })
  useEngineStore.setState({ enabled: true, analysisByFen: {} })
  useEngineStore.getState().hydrateAnalysisCache({
    [fen]: {
      depth: 20,
      eval_cp: 15,
      eval_mate: null,
      best_move_uci: 'd7d5',
      pv_uci: 'd7d5 c2c4',
      multipv_rank: 1,
      engine: 'stockfish-19',
    },
  })
  await useEngineStore.getState().analyzePosition(fen, { depth: 26 })
  await vi.advanceTimersByTimeAsync(100)
  // The search starts, and the stored evaluation stays where it was.
  expect(useEngineStore.getState().currentDepth).toBe(20)
  expect(useEngineStore.getState().lines).toHaveLength(1)
  mock.callbacks!.onInfo(info(12, 1, ['g8f6', 'c2c4']))
  frames.splice(0).forEach((frame) => frame())
  expect(useEngineStore.getState().currentDepth).toBe(20)
  expect(useEngineStore.getState().bestMove).toBe('d7d5')
  mock.callbacks!.onInfo(info(21, 1, ['d7d5', 'c2c4']))
  mock.callbacks!.onInfo(info(21, 2, ['g8f6', 'c2c4'], 5))
  frames.splice(0).forEach((frame) => frame())
  expect(useEngineStore.getState().currentDepth).toBe(21)
  expect(useEngineStore.getState().lines).toHaveLength(2)
})

it('puts an interrupted library search back in the queue instead of counting it done', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  mock.analyze.mockClear()
  const library = 'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq -'
  const board = 'rnbqkbnr/pppppppp/8/8/8/2N5/PPPPPPPP/R1BQKBNR b KQkq -'
  useAppStore.setState({ currentFen: board })
  useEngineStore.setState({ enabled: true, analysisByFen: {} })
  await useEngineStore.getState().queueReplayAnalysis([library], { depth: 20, background: true })
  await vi.advanceTimersByTimeAsync(10)
  expect(mock.analyze).toHaveBeenLastCalledWith(library, expect.objectContaining({ depth: 20 }))
  // The player looks at the board; the library search gives way.
  await useEngineStore.getState().analyzePosition(board, { depth: 26 })
  await vi.advanceTimersByTimeAsync(100)
  expect(mock.analyze).toHaveBeenLastCalledWith(board, expect.objectContaining({ depth: 26 }))
  expect(useEngineStore.getState().replayQueueCompleted).toBe(0)
  // The board search ends; the library position is searched again.
  mock.callbacks!.onInfo(info(26, 1, ['d7d5']))
  mock.callbacks!.onBestMove('d7d5')
  await vi.advanceTimersByTimeAsync(10)
  expect(mock.analyze).toHaveBeenLastCalledWith(library, expect.objectContaining({ depth: 20 }))
})
