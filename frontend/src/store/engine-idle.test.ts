import { afterEach, expect, it, vi } from 'vite-plus/test'

import type { EngineCallbacks } from '@/lib/stockfish/engine'
import { ENGINE_IDLE_RELEASE_MS, useEngineStore } from './engine-store'
import { useSparStore } from './spar-store'

const mock = vi.hoisted(() => ({
  callbacks: null as EngineCallbacks | null,
  created: 0,
  destroyed: 0,
  analyze: vi.fn(),
}))
vi.mock('@/lib/stockfish/engine', () => ({
  StockfishEngine: class {
    constructor(callbacks: EngineCallbacks) {
      mock.callbacks = callbacks
      mock.created += 1
    }
    async init() {}
    analyze = mock.analyze
    stop() {}
    destroy() {
      mock.destroyed += 1
    }
  },
}))

const FEN = 'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq -'

function setup() {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  mock.created = 0
  mock.destroyed = 0
  useEngineStore.setState({ enabled: true, analysisByFen: {} })
}

async function searchAndFinish(fen: string) {
  await useEngineStore.getState().analyzePosition(fen, { depth: 20, deep: true })
  await vi.advanceTimersByTimeAsync(100)
  mock.callbacks!.onInfo({
    depth: 20,
    seldepth: null,
    multipv: 1,
    score: { type: 'cp', value: 15 },
    nodes: null,
    nps: null,
    time: null,
    pv: ['e7e5'],
  })
  mock.callbacks!.onBestMove('e7e5')
}

afterEach(async () => {
  useSparStore.setState({ status: 'idle' })
  // Switching off releases the worker and clears its idle timer, which a
  // switch back to real timers would otherwise leave pointing at nothing.
  if (useEngineStore.getState().enabled) await useEngineStore.getState().toggle()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('gives the worker back after five idle minutes, keeping what it found', async () => {
  setup()
  await searchAndFinish(FEN)
  await vi.advanceTimersByTimeAsync(ENGINE_IDLE_RELEASE_MS - 1_000)
  expect(mock.destroyed).toBe(0)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(mock.destroyed).toBe(1)
  expect(useEngineStore.getState().isReady).toBe(false)
  expect(useEngineStore.getState().enabled).toBe(true)
  expect(useEngineStore.getState().analysisByFen[FEN]?.depth).toBe(20)

  // The next search builds a new worker.
  await useEngineStore
    .getState()
    .analyzePosition('rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq -', {
      depth: 20,
      deep: true,
    })
  await vi.advanceTimersByTimeAsync(100)
  expect(mock.created).toBeGreaterThanOrEqual(2)
})

it('keeps the worker through a game against the engine', async () => {
  setup()
  await searchAndFinish(FEN)
  useSparStore.setState({ status: 'playing' })
  await vi.advanceTimersByTimeAsync(ENGINE_IDLE_RELEASE_MS * 3)
  expect(mock.destroyed).toBe(0)
  useSparStore.setState({ status: 'idle' })
  await vi.advanceTimersByTimeAsync(ENGINE_IDLE_RELEASE_MS + 1_000)
  expect(mock.destroyed).toBe(1)
})
