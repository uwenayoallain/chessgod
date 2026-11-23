import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { StockfishEngine } from '@/lib/stockfish/engine'
import type { UCIInfo } from '@/lib/stockfish/uci'

import { useAppStore } from './app-store'
import {
  getEngineThreadCount,
  MAX_ANALYSIS_CACHE_ENTRIES,
  trimAnalysisCache,
  useEngineStore,
} from './engine-store'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'

describe('engine store persisted analysis hydration', () => {
  it('hands a game to the pool and leaves the board search waiting behind it', async () => {
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
      await useEngineStore.getState().queueReplayAnalysis([child], { depth: 20 })
      await vi.advanceTimersByTimeAsync(1_000)
      // The pending interactive search is dropped; the game goes to the pool,
      // each position with a time limit so none can hold an engine for long.
      expect(analyze).not.toHaveBeenCalled()
      expect(play).toHaveBeenCalledExactlyOnceWith(child, {
        depth: 20,
        multiPV: 1,
        movetime: 4_000,
      })
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
          movetime: 45_000,
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
      await useEngineStore.getState().queueReplayAnalysis([START], { depth: 20 })
      await Promise.resolve()
      expect(play).toHaveBeenCalledWith(START, { depth: 20, multiPV: 1, movetime: 4_000 })
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

  it('reuses a running review asked for the same positions again', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    vi.spyOn(StockfishEngine.prototype, 'init').mockResolvedValue()
    vi.spyOn(StockfishEngine.prototype, 'stop').mockImplementation(() => {})
    const destroy = vi.spyOn(StockfishEngine.prototype, 'destroy').mockImplementation(() => {})
    const play = vi
      .spyOn(StockfishEngine.prototype, 'play')
      .mockImplementation(() => new Promise(() => {}))
    const child = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
    useEngineStore.setState({ enabled: true, analysisByFen: {} })
    try {
      // Loading a game and opening its review ask within a moment of each other.
      expect(
        await useEngineStore.getState().queueReplayAnalysis([START, child], { depth: 20 }),
      ).toBe(2)
      await Promise.resolve()
      const searches = play.mock.calls.length
      expect(
        await useEngineStore.getState().queueReplayAnalysis([START, child], { depth: 20 }),
      ).toBe(2)
      await Promise.resolve()
      expect(play.mock.calls.length).toBe(searches)
      expect(destroy).not.toHaveBeenCalled()
      expect(useEngineStore.getState().replayQueueActive).toBe(true)
      // A different game is a new review.
      const other = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -'
      await useEngineStore.getState().queueReplayAnalysis([other], { depth: 20 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(destroy).toHaveBeenCalled()
    } finally {
      useEngineStore.getState().stop()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })

  it('holds the board search while a game review runs, and starts it after', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.spyOn(StockfishEngine.prototype, 'init').mockResolvedValue()
    vi.spyOn(StockfishEngine.prototype, 'stop').mockImplementation(() => {})
    vi.spyOn(StockfishEngine.prototype, 'destroy').mockImplementation(() => {})
    const analyze = vi.spyOn(StockfishEngine.prototype, 'analyze').mockImplementation(() => {})
    const finishReview: Array<() => void> = []
    vi.spyOn(StockfishEngine.prototype, 'play').mockImplementation(
      () => new Promise((resolve) => finishReview.push(() => resolve(null))),
    )
    const child = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
    useEngineStore.setState({ enabled: true, analysisByFen: {} })
    try {
      await useEngineStore.getState().queueReplayAnalysis([child], { depth: 20 })
      await useEngineStore.getState().analyzePosition(START, { depth: 26 })
      await vi.advanceTimersByTimeAsync(500)
      // Two threads on top of the review's pool oversubscribed the cores.
      expect(analyze).not.toHaveBeenCalled()
      // Every search comes back empty (the review's one position, then the
      // board position the pool searched ahead of it); the review ends.
      for (let round = 0; round < 8 && finishReview.length; round += 1) {
        finishReview.shift()?.()
        await vi.advanceTimersByTimeAsync(10)
      }
      expect(useEngineStore.getState().replayQueueActive).toBe(false)
      expect(analyze).toHaveBeenCalledExactlyOnceWith(START, {
        depth: 26,
        multiPV: 2,
        force: true,
        movetime: 12_000,
      })
    } finally {
      useEngineStore.getState().stop()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('keeps the deeper-search switch working when the browser refuses storage', async () => {
    // With site data blocked the `localStorage` accessor itself throws. The
    // choice then lasts for this visit, and flipping it must not throw.
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      get localStorage(): Storage {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    })
    vi.spyOn(StockfishEngine.prototype, 'init').mockResolvedValue()
    vi.spyOn(StockfishEngine.prototype, 'stop').mockImplementation(() => {})
    vi.spyOn(StockfishEngine.prototype, 'destroy').mockImplementation(() => {})
    const original = useEngineStore.getState().highPerformance
    const originalEnabled = useEngineStore.getState().enabled
    useEngineStore.setState({ enabled: false })
    try {
      await useEngineStore.getState().setHighPerformance(!original)
      expect(useEngineStore.getState().highPerformance).toBe(!original)
      await useEngineStore.getState().setHighPerformance(original)
      expect(useEngineStore.getState().highPerformance).toBe(original)
    } finally {
      useEngineStore.getState().stop()
      useEngineStore.setState({ enabled: originalEnabled })
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

describe('game review and the board', () => {
  const CHILD = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
  const SIDE_LINE = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -'

  function info(depth: number, pv: string[], multipv = 1): UCIInfo {
    return {
      depth,
      seldepth: null,
      multipv,
      score: { type: 'cp', value: 20 },
      nodes: null,
      nps: null,
      time: null,
      pv,
    }
  }

  function setup() {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.spyOn(StockfishEngine.prototype, 'init').mockResolvedValue()
    vi.spyOn(StockfishEngine.prototype, 'stop').mockImplementation(() => {})
    const destroy = vi.spyOn(StockfishEngine.prototype, 'destroy').mockImplementation(() => {})
    const analyze = vi.spyOn(StockfishEngine.prototype, 'analyze').mockImplementation(() => {})
    const pending: Array<{ fen: string; resolve: (lines: UCIInfo[] | null) => void }> = []
    const play = vi
      .spyOn(StockfishEngine.prototype, 'play')
      .mockImplementation((fen) => new Promise((resolve) => pending.push({ fen, resolve })))
    return { analyze, destroy, pending, play }
  }

  function teardown(currentFen: string) {
    useEngineStore.getState().stop()
    useAppStore.setState({ currentFen })
    useEngineStore.setState({ analysisByFen: {}, analyzedFen: null, lines: [] })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }

  it('keeps the lines of an analysed position on the board when its game review starts', async () => {
    const previousFen = useAppStore.getState().currentFen
    setup()
    const known = info(24, ['e7e5'])
    useAppStore.setState({ currentFen: CHILD })
    useEngineStore.setState({
      enabled: true,
      analyzedFen: CHILD,
      lines: [known],
      analysisByFen: { [CHILD]: { bestMove: 'e7e5', depth: 24, lines: [known] } },
    })
    try {
      await useEngineStore.getState().queueReplayAnalysis([START, CHILD], { depth: 20 })
      const state = useEngineStore.getState()
      expect(state.analyzedFen).toBe(CHILD)
      expect(state.lines).toEqual([known])
      expect(state.replayQueueActive).toBe(true)
    } finally {
      teardown(previousFen)
    }
  })

  it('searches a side line the player steps onto ahead of the rest of the review', async () => {
    const previousFen = useAppStore.getState().currentFen
    const { pending, play } = setup()
    useEngineStore.setState({ enabled: true, analysisByFen: {} })
    useAppStore.setState({ currentFen: CHILD })
    try {
      await useEngineStore.getState().queueReplayAnalysis([START, CHILD], { depth: 20 })
      await vi.advanceTimersByTimeAsync(10)
      // The player tries 1.d4 instead while the review runs.
      useAppStore.setState({ currentFen: SIDE_LINE })
      await useEngineStore.getState().analyzePosition(SIDE_LINE, { depth: 26 })
      await vi.advanceTimersByTimeAsync(100)
      const busy = pending.length
      // The next engine to come free takes the side line before its own work.
      pending.shift()?.resolve([info(20, ['e2e4'])])
      await vi.advanceTimersByTimeAsync(10)
      expect(play.mock.calls.length).toBe(busy + 1)
      expect(play).toHaveBeenLastCalledWith(SIDE_LINE, { depth: 26, multiPV: 2, movetime: 4_000 })
      const side = pending.find((search) => search.fen === SIDE_LINE)!
      side.resolve([info(19, ['d7d5']), info(19, ['g8f6'], 2)])
      await vi.advanceTimersByTimeAsync(10)
      const state = useEngineStore.getState()
      expect(state.analyzedFen).toBe(SIDE_LINE)
      expect(state.lines.map((line) => line.pv[0])).toEqual(['d7d5', 'g8f6'])
      // Not one of the review's positions: its progress does not move.
      expect(state.replayQueueCompleted).toBe(1)
      expect(state.replayQueueTotal).toBe(2)
    } finally {
      teardown(previousFen)
    }
  })

  it('treats a review search cut short by its time limit as done for this session', async () => {
    const previousFen = useAppStore.getState().currentFen
    const { pending, play } = setup()
    useEngineStore.setState({ enabled: true, analysisByFen: {} })
    try {
      await useEngineStore.getState().queueReplayAnalysis([CHILD], { depth: 20 })
      await vi.advanceTimersByTimeAsync(10)
      // Four seconds reached depth 19: deep enough to grade from.
      pending.shift()?.resolve([info(19, ['e7e5'])])
      await vi.advanceTimersByTimeAsync(10)
      expect(useEngineStore.getState().replayQueueActive).toBe(false)
      const searches = play.mock.calls.length
      // Opening the same game again does not search it again for the same four seconds.
      expect(await useEngineStore.getState().queueReplayAnalysis([CHILD], { depth: 20 })).toBe(0)
      await vi.advanceTimersByTimeAsync(10)
      expect(play.mock.calls.length).toBe(searches)
    } finally {
      teardown(previousFen)
    }
  })

  it('still runs a deeper review of a position whose shallower review was cut short', async () => {
    const previousFen = useAppStore.getState().currentFen
    const { pending, play } = setup()
    useEngineStore.setState({ enabled: true, analysisByFen: {} })
    try {
      await useEngineStore.getState().queueReplayAnalysis([CHILD], { depth: 20 })
      await vi.advanceTimersByTimeAsync(10)
      // Four seconds reached depth 19 of the 20 asked for.
      pending.shift()?.resolve([info(19, ['e7e5'])])
      await vi.advanceTimersByTimeAsync(10)
      // That says what four seconds reach. A review asked for at 22 gets
      // sixteen, and must not be turned away as already done at 19.
      expect(await useEngineStore.getState().queueReplayAnalysis([CHILD], { depth: 22 })).toBe(1)
      await vi.advanceTimersByTimeAsync(10)
      expect(play).toHaveBeenLastCalledWith(CHILD, { depth: 22, multiPV: 1, movetime: 16_000 })
      pending.shift()?.resolve([info(22, ['e7e5'])])
      await vi.advanceTimersByTimeAsync(10)
      // Past the review band the same holds, and the search has no time limit.
      expect(await useEngineStore.getState().queueReplayAnalysis([CHILD], { depth: 26 })).toBe(1)
      await vi.advanceTimersByTimeAsync(10)
      expect(play.mock.calls.at(-1)?.[0]).toBe(CHILD)
      expect(play.mock.calls.at(-1)?.[1]).toMatchObject({ depth: 26 })
      // The cap still answers a request no deeper than the one it was cut from.
      pending.shift()?.resolve([info(26, ['e7e5'])])
      await vi.advanceTimersByTimeAsync(10)
      expect(await useEngineStore.getState().queueReplayAnalysis([CHILD], { depth: 20 })).toBe(0)
    } finally {
      teardown(previousFen)
    }
  })

  it('keeps the board search waiting until every overlapping opponent search is over', async () => {
    const previousFen = useAppStore.getState().currentFen
    const { analyze, pending } = setup()
    useEngineStore.setState({ enabled: true, analysisByFen: {} })
    try {
      await useEngineStore.getState().analyzePosition(START, { depth: 30, deep: true })
      await vi.advanceTimersByTimeAsync(60)
      expect(analyze).toHaveBeenCalledTimes(1)
      // The opponent starts choosing a move, and a second search (a takeback,
      // a new game) starts before the first has answered.
      const first = useEngineStore.getState().playMove(CHILD, { depth: 2, multiPV: 8 })
      await vi.advanceTimersByTimeAsync(10)
      const second = useEngineStore.getState().playMove(SIDE_LINE, { depth: 2, multiPV: 8 })
      await vi.advanceTimersByTimeAsync(10)
      expect(pending.map((search) => search.fen)).toEqual([CHILD, SIDE_LINE])

      // The first answers while the second still owns the worker: the board
      // search stays queued instead of stopping the opponent's search.
      pending[0].resolve([info(2, ['e7e5'])])
      await first
      await vi.advanceTimersByTimeAsync(10)
      expect(analyze).toHaveBeenCalledTimes(1)

      pending[1].resolve([info(2, ['d7d5'])])
      await second
      await vi.advanceTimersByTimeAsync(10)
      expect(analyze).toHaveBeenCalledTimes(2)
      expect(analyze).toHaveBeenLastCalledWith(START, expect.objectContaining({ depth: 30 }))
    } finally {
      teardown(previousFen)
    }
  })

  it('reviews a position the board only searched deeper, and keeps both searches', async () => {
    const previousFen = useAppStore.getState().currentFen
    const { pending, play } = setup()
    const deep = info(28, ['e7e5'])
    useEngineStore.setState({
      enabled: true,
      analysisByFen: { [CHILD]: { bestMove: 'e7e5', depth: 28, lines: [deep] } },
    })
    try {
      // Depth 28 cannot be differenced against a partner reviewed at 20.
      expect(await useEngineStore.getState().queueReplayAnalysis([CHILD], { depth: 20 })).toBe(1)
      await vi.advanceTimersByTimeAsync(10)
      expect(play).toHaveBeenCalledWith(CHILD, { depth: 20, multiPV: 1, movetime: 4_000 })
      const review = info(20, ['c7c5'])
      pending.shift()?.resolve([review])
      await vi.advanceTimersByTimeAsync(10)
      const cached = useEngineStore.getState().analysisByFen[CHILD]
      expect(cached.lines).toEqual([deep])
      expect(cached.reviewLine).toEqual(review)
    } finally {
      teardown(previousFen)
    }
  })

  it('hydrates a review-depth row beside a deeper board search', () => {
    const deep = info(28, ['e7e5'])
    useEngineStore.setState({
      analysisByFen: { [CHILD]: { bestMove: 'e7e5', depth: 28, lines: [deep] } },
    })
    try {
      useEngineStore.getState().hydrateAnalysisCache({
        [CHILD]: {
          depth: 20,
          eval_cp: 10,
          eval_mate: null,
          best_move_uci: 'c7c5',
          pv_uci: 'c7c5',
          multipv_rank: 1,
          engine: 'stockfish-19',
        },
      })
      const cached = useEngineStore.getState().analysisByFen[CHILD]
      expect(cached.lines).toEqual([deep])
      expect(cached.reviewLine?.depth).toBe(20)
      expect(cached.reviewLine?.pv).toEqual(['c7c5'])
    } finally {
      useEngineStore.setState({ analysisByFen: {} })
    }
  })

  it('stops the library crawl without touching a running game review', async () => {
    const previousFen = useAppStore.getState().currentFen
    const { analyze, destroy, pending, play } = setup()
    useEngineStore.setState({ enabled: true, analysisByFen: {} })
    try {
      await useEngineStore.getState().queueReplayAnalysis([CHILD], { depth: 20 })
      await useEngineStore
        .getState()
        .queueReplayAnalysis([SIDE_LINE], { depth: 22, background: true })
      await vi.advanceTimersByTimeAsync(10)
      const searches = play.mock.calls.length
      useEngineStore.getState().stopLibraryCrawl()
      expect(destroy).not.toHaveBeenCalled()
      expect(useEngineStore.getState().replayQueueActive).toBe(true)
      // The review finishes and reports; the crawl's position never runs.
      pending.shift()?.resolve([info(20, ['e7e5'])])
      await vi.advanceTimersByTimeAsync(10)
      expect(useEngineStore.getState().analysisByFen[CHILD]).toBeDefined()
      expect(useEngineStore.getState().analysisByFen[SIDE_LINE]).toBeUndefined()
      expect(play.mock.calls.length).toBe(searches)
      expect(analyze).not.toHaveBeenCalled()
    } finally {
      teardown(previousFen)
    }
  })
})
