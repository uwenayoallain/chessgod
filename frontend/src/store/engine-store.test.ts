import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { StockfishEngine } from '@/lib/stockfish/engine'

import {
  getEngineThreadCount,
  MAX_ANALYSIS_CACHE_ENTRIES,
  trimAnalysisCache,
  useEngineStore,
} from './engine-store'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'

describe('engine store persisted analysis hydration', () => {
  it('cancels pending interactive searches when a game batch takes over', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    vi.spyOn(StockfishEngine.prototype, 'init').mockResolvedValue()
    vi.spyOn(StockfishEngine.prototype, 'stop').mockImplementation(() => {})
    const analyze = vi.spyOn(StockfishEngine.prototype, 'analyze').mockImplementation(() => {})
    const play = vi
      .spyOn(StockfishEngine.prototype, 'play')
      .mockImplementation(() => new Promise(() => {}))
    const child = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
    useEngineStore.setState({ enabled: true, analysisByFen: {} })
    try {
      await useEngineStore.getState().analyzePosition(START, { depth: 30 })
      await useEngineStore.getState().queueReplayAnalysis([child], { depth: 22 })
      await vi.advanceTimersByTimeAsync(1_000)
      // The pending interactive search is dropped; the game goes to the pool.
      expect(analyze).not.toHaveBeenCalled()
      expect(play).toHaveBeenCalledExactlyOnceWith(child, { depth: 22, multiPV: 1 })
      expect(useEngineStore.getState().replayQueueCompleted).toBe(0)
      expect(useEngineStore.getState().replayQueueActive).toBe(true)
    } finally {
      useEngineStore.getState().stop()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it.each(['empty', 'cached', 'new', 'duplicate'])(
    'preserves the foreground search when a %s background batch arrives',
    async (batch) => {
      vi.useFakeTimers()
      vi.stubGlobal('window', { setTimeout, clearTimeout })
      vi.spyOn(StockfishEngine.prototype, 'init').mockResolvedValue()
      const stop = vi.spyOn(StockfishEngine.prototype, 'stop').mockImplementation(() => {})
      const analyze = vi.spyOn(StockfishEngine.prototype, 'analyze').mockImplementation(() => {})
      const child = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
      useEngineStore.setState({ enabled: true, analysisByFen: {} })
      try {
        await useEngineStore.getState().analyzePosition(START, { depth: 30, deep: true })
        await vi.advanceTimersByTimeAsync(60)
        if (batch === 'cached') {
          useEngineStore.getState().hydrateAnalysisCache({
            [child]: {
              depth: 22,
              eval_cp: 10,
              eval_mate: null,
              best_move_uci: 'e7e5',
              pv_uci: 'e7e5',
              multipv_rank: 1,
              engine: 'stockfish-19',
            },
          })
        }
        const before = useEngineStore.getState()
        const queued = await useEngineStore
          .getState()
          .queueReplayAnalysis(batch === 'empty' ? [] : [batch === 'duplicate' ? START : child], {
            depth: 22,
            background: true,
          })
        expect(queued).toBe(batch === 'new' ? 1 : 0)
        await useEngineStore.getState().analyzePosition(START, { depth: 30, deep: true })
        await vi.advanceTimersByTimeAsync(60)
        expect(stop).not.toHaveBeenCalled()
        expect(analyze).toHaveBeenCalledExactlyOnceWith(START, {
          depth: 30,
          multiPV: 3,
          force: true,
        })
        expect(useEngineStore.getState().analyzedFen).toBe(before.analyzedFen)
        expect(useEngineStore.getState().isAnalyzing).toBe(true)
        expect(useEngineStore.getState().replayQueueTotal).toBe(batch === 'new' ? 1 : 0)
      } finally {
        useEngineStore.getState().stop()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
        vi.useRealTimers()
      }
    },
  )

  it('starts an explicitly requested game analysis after the engine was disabled', async () => {
    const originalEnabled = useEngineStore.getState().enabled
    vi.stubGlobal('window', { setTimeout: vi.fn(), clearTimeout: vi.fn() })
    vi.spyOn(StockfishEngine.prototype, 'init').mockResolvedValue()
    vi.spyOn(StockfishEngine.prototype, 'stop').mockImplementation(() => {})
    const play = vi
      .spyOn(StockfishEngine.prototype, 'play')
      .mockImplementation(() => new Promise(() => {}))
    useEngineStore.setState({ enabled: false, analysisByFen: {} })
    try {
      await useEngineStore.getState().queueReplayAnalysis([START], { depth: 22 })
      await Promise.resolve()
      expect(play).toHaveBeenCalledWith(START, { depth: 22, multiPV: 1 })
      expect(useEngineStore.getState().enabled).toBe(true)
      expect(useEngineStore.getState().replayQueueTotal).toBe(1)
      expect(useEngineStore.getState().replayQueueStartedAt).toEqual(expect.any(Number))
    } finally {
      useEngineStore.getState().stop()
      useEngineStore.setState({ enabled: originalEnabled })
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })

  it('reports the positions it actually took, not the ones it was offered', async () => {
    vi.stubGlobal('window', { setTimeout: vi.fn(), clearTimeout: vi.fn() })
    vi.spyOn(StockfishEngine.prototype, 'init').mockResolvedValue()
    vi.spyOn(StockfishEngine.prototype, 'stop').mockImplementation(() => {})
    vi.spyOn(StockfishEngine.prototype, 'analyze').mockImplementation(() => {})
    const checkmate = 'k7/1Q6/2K5/8/8/8/8/8 b - -'
    useEngineStore.setState({ enabled: true, analysisByFen: {} })
    try {
      // A caller that polls for more work has to be able to tell "queued 24"
      // from "queued none"; reporting the offered count spins forever.
      expect(await useEngineStore.getState().queueReplayAnalysis([START], { depth: 22 })).toBe(1)
      expect(await useEngineStore.getState().queueReplayAnalysis([checkmate])).toBe(0)
    } finally {
      useEngineStore.getState().stop()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })

  it('searches each position to the depth its partner already carries', async () => {
    vi.stubGlobal('window', { setTimeout: vi.fn(), clearTimeout: vi.fn() })
    vi.spyOn(StockfishEngine.prototype, 'init').mockResolvedValue()
    vi.spyOn(StockfishEngine.prototype, 'stop').mockImplementation(() => {})
    const play = vi
      .spyOn(StockfishEngine.prototype, 'play')
      .mockImplementation(() => new Promise(() => {}))
    const child = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
    useEngineStore.setState({ enabled: true, analysisByFen: {} })
    try {
      // The parent of this decision was studied at depth 30, so grading the
      // move needs the child at 30 too — a depth-22 result could not be
      // differenced against it.
      const queued = await useEngineStore
        .getState()
        .queueReplayAnalysis([child], { depth: 22, depthByFen: { [child]: 30 } })
      expect(queued).toBe(1)
      await Promise.resolve()
      expect(play).toHaveBeenCalledExactlyOnceWith(child, { depth: 30, multiPV: 1 })
    } finally {
      useEngineStore.getState().stop()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })

  it('uses the thread count that searched fastest in the browser', () => {
    expect(getEngineThreadCount(1)).toBe(1)
    expect(getEngineThreadCount(2)).toBe(1)
    expect(getEngineThreadCount(4)).toBe(2)
    expect(getEngineThreadCount(32)).toBe(2)
  })

  it('bounds replay memory while preserving the active FEN', () => {
    const cache = Object.fromEntries(
      Array.from({ length: MAX_ANALYSIS_CACHE_ENTRIES + 3 }, (_, index) => [`fen-${index}`, index]),
    )
    const active = `fen-${MAX_ANALYSIS_CACHE_ENTRIES + 2}`
    const trimmed = trimAnalysisCache(cache, active)
    expect(Object.keys(trimmed)).toHaveLength(MAX_ANALYSIS_CACHE_ENTRIES)
    expect(trimmed[active]).toBe(MAX_ANALYSIS_CACHE_ENTRIES + 2)
  })
  it('does not start a worker or fabricate an evaluation for terminal-only replay', async () => {
    const fen = 'k7/1Q6/2K5/8/8/8/8/8 b - -'
    await useEngineStore.getState().queueReplayAnalysis([fen])
    await useEngineStore.getState().analyzePosition(fen, { force: true })
    const state = useEngineStore.getState()
    expect(state.replayQueueActive).toBe(false)
    expect(state.replayQueueTotal).toBe(0)
    expect(state.replayQueueStartedAt).toBeNull()
    expect(state.isAnalyzing).toBe(false)
    expect(state.analysisByFen[fen]).toBeUndefined()
  })
  beforeEach(() => {
    useEngineStore.setState({
      analysisByFen: {},
      analysisVersion: 0,
    })
  })

  it('hydrates saved analysis into the in-memory engine cache', () => {
    useEngineStore.getState().hydrateAnalysisCache({
      [START]: {
        depth: 20,
        eval_cp: 34,
        eval_mate: null,
        best_move_uci: 'd2d4',
        engine: 'stockfish-19',
        pv_uci: 'd2d4 d7d5 c2c4',
        multipv_rank: 1,
      },
    })

    const cached = useEngineStore.getState().analysisByFen[START]
    expect(cached.depth).toBe(20)
    expect(cached.bestMove).toBe('d2d4')
    expect(cached.lines[0]).toMatchObject({
      depth: 20,
      multipv: 1,
      score: { type: 'cp', value: 34 },
      pv: ['d2d4', 'd7d5', 'c2c4'],
    })
  })

  it('keeps deeper in-memory analysis over shallower persisted rows', () => {
    useEngineStore.setState({
      analysisByFen: {
        'fen-a': {
          depth: 24,
          bestMove: 'e2e4',
          lines: [
            {
              depth: 24,
              seldepth: null,
              multipv: 1,
              score: { type: 'cp', value: 10 },
              nodes: null,
              nps: null,
              time: null,
              pv: ['e2e4'],
            },
          ],
        },
      },
    })

    useEngineStore.getState().hydrateAnalysisCache({
      'fen-a': {
        depth: 20,
        eval_cp: 34,
        eval_mate: null,
        best_move_uci: 'd2d4',
        engine: 'stockfish-19',
        pv_uci: 'd2d4',
        multipv_rank: 1,
      },
    })

    expect(useEngineStore.getState().analysisByFen['fen-a'].bestMove).toBe('e2e4')
  })

  it('converts persisted white-perspective scores for black-to-move engine consumers', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
    useEngineStore.getState().hydrateAnalysisCache({
      [fen]: {
        depth: 24,
        eval_cp: -80,
        eval_mate: null,
        best_move_uci: 'e7e5',
        engine: 'stockfish-19',
        pv_uci: 'e7e5 g1f3',
        multipv_rank: 1,
      },
    })

    expect(useEngineStore.getState().analysisByFen[fen].lines[0].score).toEqual({
      type: 'cp',
      value: 80,
    })
  })

  it('ignores persisted analysis from a different engine', () => {
    useEngineStore.getState().hydrateAnalysisCache({
      'fen-a': {
        depth: 40,
        eval_cp: 20,
        eval_mate: null,
        best_move_uci: 'e2e4',
        pv_uci: 'e2e4 e7e5',
        multipv_rank: 1,
        engine: 'lichess-cloud',
      },
    })

    expect(useEngineStore.getState().analysisByFen['fen-a']).toBeUndefined()
  })

  it('preserves local alternatives when a deeper primary arrives from the database', () => {
    const primary = {
      depth: 24,
      seldepth: null,
      multipv: 1,
      score: { type: 'cp' as const, value: 30 },
      nodes: null,
      nps: null,
      time: null,
      pv: ['e2e4'],
    }
    const alternative = { ...primary, multipv: 2, pv: ['d2d4'] }
    useEngineStore.setState({
      analysisByFen: {
        [START]: {
          depth: 24,
          bestMove: 'e2e4',
          engine: 'stockfish-19',
          lines: [primary, alternative],
        },
      },
    })
    useEngineStore.getState().hydrateAnalysisCache({
      [START]: {
        depth: 30,
        eval_cp: 35,
        eval_mate: null,
        best_move_uci: 'e2e4',
        pv_uci: 'e2e4',
        multipv_rank: 1,
        engine: 'stockfish-19',
      },
    })
    const cached = useEngineStore.getState().analysisByFen[START]
    expect(cached.depth).toBe(30)
    expect(cached.lines).toHaveLength(2)
    expect(cached.lines[1]).toBe(alternative)
    expect(cached.persisted).toBe(false)
  })

  it.each([false, true])('reuses one complete line for a forced move (deep=%s)', async (deep) => {
    const fen = 'k7/R1K5/8/8/8/8/8/8 b - -'
    useEngineStore.getState().hydrateAnalysisCache({
      [fen]: {
        depth: 30,
        eval_cp: 0,
        eval_mate: null,
        best_move_uci: 'a8a7',
        pv_uci: 'a8a7',
        multipv_rank: 1,
        engine: 'stockfish-19',
      },
    })
    // Any scheduled search would be redundant; keep the test worker-free.
    const setTimeout = vi.fn()
    vi.stubGlobal('window', { setTimeout, clearTimeout: vi.fn() })
    try {
      await useEngineStore.getState().analyzePosition(fen, { depth: 30, stable: true, deep })
      expect(setTimeout).not.toHaveBeenCalled()
      expect(useEngineStore.getState().isAnalyzing).toBe(false)
      expect(useEngineStore.getState().bestMove).toBe('a8a7')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
