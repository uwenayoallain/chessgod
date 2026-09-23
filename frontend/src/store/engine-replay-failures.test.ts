import { afterEach, expect, it, vi } from 'vite-plus/test'

import type { EngineCallbacks } from '@/lib/stockfish/engine'
import { getReplayTimedOutFens, useEngineStore } from './engine-store'

const mock = vi.hoisted(() => ({ callbacks: null as EngineCallbacks | null, analyze: vi.fn() }))
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

afterEach(() => {
  useEngineStore.getState().stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('defers an exhausted replay failure so later automatic batches can advance', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
  // The automatic library batches run on the main queue; a single game's
  // review goes to its own pool (see engine-store.test.ts).
  useEngineStore.setState({ enabled: true, analysisByFen: {} })
  await useEngineStore.getState().queueReplayAnalysis([fen], { depth: 22, background: true })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(mock.analyze).toHaveBeenCalledTimes(attempt + 1)
    expect(getReplayTimedOutFens()).not.toContain(fen)
    mock.callbacks!.onError('search failed')
    await vi.advanceTimersByTimeAsync(0)
  }
  expect(mock.analyze).toHaveBeenCalledTimes(3)
  expect(useEngineStore.getState().replayQueueActive).toBe(false)
  expect(useEngineStore.getState().replayQueueCompleted).toBe(1)
  expect(useEngineStore.getState().analysisByFen[fen]).toBeUndefined()
  expect(getReplayTimedOutFens()).toContain(fen)
})

it('runs background work after foreground completion without duplicating queued positions', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  mock.analyze.mockClear()
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
  const child = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
  useEngineStore.setState({ enabled: true, analysisByFen: {} })
  await useEngineStore.getState().analyzePosition(fen, { depth: 30, deep: true })
  await vi.advanceTimersByTimeAsync(60)
  const options = { background: true, depth: 22, depthByFen: { [child]: 30 } }
  expect(await useEngineStore.getState().queueReplayAnalysis([child], options)).toBe(1)
  expect(await useEngineStore.getState().queueReplayAnalysis([child], options)).toBe(0)
  expect(mock.analyze).toHaveBeenCalledTimes(1)
  expect(useEngineStore.getState().replayQueueTotal).toBe(1)
  mock.callbacks!.onBestMove('e2e4')
  await vi.advanceTimersByTimeAsync(0)
  expect(mock.analyze).toHaveBeenCalledTimes(2)
  expect(mock.analyze).toHaveBeenLastCalledWith(child, { depth: 30, multiPV: 1, force: true })
  mock.callbacks!.onBestMove('e7e5')
  expect(useEngineStore.getState().replayQueueCompleted).toBe(1)
  expect(useEngineStore.getState().replayQueueActive).toBe(false)
})
