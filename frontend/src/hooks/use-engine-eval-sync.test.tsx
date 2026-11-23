// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vite-plus/test'

import { useEngineStore, type CachedEngineAnalysis } from '@/store/engine-store'
import { mergeEngineAnalysis } from '@/lib/analysis/analysis-cache'
import { useEngineEvalSync } from './use-engine-eval-sync'

const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { post, getUri: () => 'http://localhost:8011/api/analysis/evaluations' },
}))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  post.mockReset()
})

it.each([false, true])(
  'recovers from item validation errors without losing newer results (%s)',
  async (replaceRejected) => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    post.mockReset()
    useEngineStore.setState({ analysisByFen: {}, analysisVersion: 0 })
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
    const save = (depth: number) => {
      useEngineStore.setState((state) => ({
        analysisVersion: state.analysisVersion + 1,
        analysisByFen: {
          [fen]: {
            depth,
            engine: 'stockfish-19',
            bestMove: 'e2e4',
            lines: ['e2e4', 'd2d4'].map((move, index) => ({
              depth,
              multipv: index + 1,
              score: { type: 'cp' as const, value: 30 },
              pv: [move],
              nodes: null,
              nps: null,
              time: null,
              seldepth: null,
            })),
          },
        },
      }))
    }
    let rejectUpload!: (error: unknown) => void
    post.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject
        }),
    )
    post.mockResolvedValue({ data: { stored: 1 } })
    const { unmount } = renderHook(() => useEngineEvalSync())
    try {
      act(() => save(22))
      await act(() => vi.advanceTimersByTimeAsync(3_000))
      if (replaceRejected) act(() => save(30))
      await act(async () => {
        rejectUpload({
          isAxiosError: true,
          response: {
            status: 422,
            data: { detail: [{ loc: ['body', 'items', 0, 'eval_cp'], msg: 'Invalid score' }] },
          },
        })
      })
      expect(post).toHaveBeenCalledTimes(2)
      // The deeper search queues beside the review-depth rows, not over them:
      // the surviving depth-22 line still goes, and the rejected one does not.
      expect(post.mock.calls[1][1].items).toEqual(
        replaceRejected
          ? [
              expect.objectContaining({ depth: 22, multipv_rank: 2 }),
              expect.objectContaining({ depth: 30, multipv_rank: 1 }),
              expect.objectContaining({ depth: 30, multipv_rank: 2 }),
            ]
          : [expect.objectContaining({ depth: 22, multipv_rank: 2 })],
      )
      await act(() => vi.advanceTimersByTimeAsync(60_000))
      expect(post).toHaveBeenCalledTimes(2)
    } finally {
      // Drain any remaining work even when the regression assertion fails.
      await act(() => vi.advanceTimersByTimeAsync(60_000))
      unmount()
    }
  },
)

it.each([
  new Error('offline'),
  { isAxiosError: true, response: { status: 503 } },
  { isAxiosError: true, response: { status: 422, data: { detail: 'Unknown failure' } } },
  { isAxiosError: true, response: { status: 422, data: { detail: [{ loc: ['body'] }] } } },
  {
    isAxiosError: true,
    response: { status: 422, data: { detail: [{ loc: ['body', 'items', 50] }] } },
  },
])('preserves newer in-flight results and retries unclassified failures (%j)', async (error) => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
  function save(depth: number, persisted = false) {
    const analysis: CachedEngineAnalysis = {
      bestMove: 'e2e4',
      depth,
      engine: 'stockfish-19',
      persisted,
      lines: [
        {
          depth,
          multipv: 1,
          score: { type: 'cp', value: depth },
          pv: ['e2e4'],
          nodes: null,
          nps: null,
          time: null,
          seldepth: null,
        },
      ],
    }
    useEngineStore.setState((state) => ({
      analysisByFen: { [fen]: analysis },
      analysisVersion: state.analysisVersion + 1,
    }))
  }
  useEngineStore.setState({ analysisByFen: {}, analysisVersion: 0 })
  let finishFirst!: () => void
  post.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishFirst = resolve
      }),
  )
  post.mockResolvedValue({ data: { stored: 1 } })
  let renders = 0
  const { unmount } = renderHook(() => {
    renders += 1
    useEngineEvalSync()
  })
  act(() => save(20))
  await act(() => vi.advanceTimersByTimeAsync(3_000))
  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0][2]).toEqual({ timeout: 15_000 })
  act(() => save(30))
  await act(async () => {
    finishFirst()
    await Promise.resolve()
  })
  expect(post).toHaveBeenCalledTimes(2)
  expect(post.mock.calls[1][1].items[0].depth).toBe(30)

  post.mockRejectedValueOnce(error)
  act(() => save(32))
  await act(() => vi.advanceTimersByTimeAsync(3_000))
  expect(post).toHaveBeenCalledTimes(3)
  await act(() => vi.advanceTimersByTimeAsync(6_000))
  expect(post).toHaveBeenCalledTimes(4)
  expect(post.mock.calls[3][1].items[0].depth).toBe(32)
  act(() => save(34, true))
  await act(() => vi.advanceTimersByTimeAsync(3_000))
  expect(post).toHaveBeenCalledTimes(4)
  expect(renders).toBe(1)
  unmount()
})

it('uploads fresh variations added to a database-hydrated snapshot', async () => {
  vi.useFakeTimers()
  post.mockClear()
  post.mockResolvedValue({ data: { stored: 2 } })
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
  useEngineStore.setState({ analysisByFen: {}, analysisVersion: 0 })
  useEngineStore.getState().hydrateAnalysisCache({
    [fen]: {
      depth: 30,
      eval_cp: 30,
      eval_mate: null,
      best_move_uci: 'e2e4',
      pv_uci: 'e2e4',
      multipv_rank: 1,
      engine: 'stockfish-19',
    },
  })
  const { unmount } = renderHook(() => useEngineEvalSync())
  await act(() => vi.advanceTimersByTimeAsync(3_000))
  expect(post).not.toHaveBeenCalled()

  const saved = useEngineStore.getState().analysisByFen[fen]
  const fresh: CachedEngineAnalysis = {
    depth: 24,
    bestMove: 'e2e4',
    engine: 'stockfish-19',
    lines: [
      { ...saved.lines[0], depth: 24 },
      { ...saved.lines[0], depth: 24, multipv: 2, pv: ['d2d4'], score: { type: 'cp', value: 20 } },
    ],
  }
  act(() => {
    useEngineStore.setState((state) => ({
      analysisByFen: { [fen]: mergeEngineAnalysis(saved, fresh) },
      analysisVersion: state.analysisVersion + 1,
    }))
  })
  await act(() => vi.advanceTimersByTimeAsync(3_000))
  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0][1].items).toEqual([
    expect.objectContaining({ depth: 30, best_move_uci: 'e2e4', multipv_rank: 1 }),
    expect.objectContaining({ depth: 24, best_move_uci: 'd2d4', multipv_rank: 2 }),
  ])
  await act(() => vi.advanceTimersByTimeAsync(6_000))
  expect(post).toHaveBeenCalledTimes(1)
  unmount()
})

it('uploads nothing searched below the trust floor', async () => {
  vi.useFakeTimers()
  post.mockClear()
  post.mockResolvedValue({ data: { stored: 1 } })
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
  const line = (depth: number, multipv: number, move: string) => ({
    depth,
    multipv,
    score: { type: 'cp' as const, value: 20 },
    pv: [move],
    nodes: null,
    nps: null,
    time: null,
    seldepth: null,
  })
  useEngineStore.setState({ analysisByFen: {}, analysisVersion: 0 })
  const { unmount } = renderHook(() => useEngineEvalSync())
  act(() => {
    useEngineStore.setState((state) => ({
      // A look cut short at depth 12 when the player stepped on, beside a
      // second line that did reach the floor.
      analysisByFen: {
        [fen]: {
          bestMove: 'e7e5',
          depth: 12,
          engine: 'stockfish-19',
          lines: [line(12, 1, 'e7e5'), line(18, 2, 'c7c5')],
        },
      },
      analysisVersion: state.analysisVersion + 1,
    }))
  })
  await act(() => vi.advanceTimersByTimeAsync(3_000))
  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0][1].items).toEqual([
    expect.objectContaining({ depth: 18, best_move_uci: 'c7c5', multipv_rank: 2 }),
  ])
  unmount()
})

const REVIEWED_FEN = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -'

function searched(depth: number, move: string, multipv = 1) {
  return {
    depth,
    multipv,
    score: { type: 'cp' as const, value: depth },
    pv: [move],
    nodes: null,
    nps: null,
    time: null,
    seldepth: null,
  }
}

it('uploads a review search that lands beside a stored deeper board search', async () => {
  vi.useFakeTimers()
  post.mockClear()
  post.mockResolvedValue({ data: { stored: 1 } })
  useEngineStore.setState({ analysisByFen: {}, analysisVersion: 0 })
  // The board searched this position to 28 on an earlier visit; it is stored.
  useEngineStore.getState().hydrateAnalysisCache({
    [REVIEWED_FEN]: {
      depth: 28,
      eval_cp: 30,
      eval_mate: null,
      best_move_uci: 'g1f3',
      pv_uci: 'g1f3',
      multipv_rank: 1,
      engine: 'stockfish-19',
    },
  })
  const { unmount } = renderHook(() => useEngineEvalSync())
  await act(() => vi.advanceTimersByTimeAsync(3_000))
  expect(post).not.toHaveBeenCalled()

  // The game review searches it again at 20 and prefers another move.
  const stored = useEngineStore.getState().analysisByFen[REVIEWED_FEN]
  const merged = mergeEngineAnalysis<CachedEngineAnalysis>(stored, {
    bestMove: 'f1c4',
    depth: 20,
    engine: 'stockfish-19',
    lines: [searched(20, 'f1c4')],
  })
  expect(merged.persisted).toBe(true)
  act(() => {
    useEngineStore.setState((state) => ({
      analysisByFen: { [REVIEWED_FEN]: merged },
      analysisVersion: state.analysisVersion + 1,
    }))
  })
  await act(() => vi.advanceTimersByTimeAsync(3_000))
  // Only the review row is new, and it carries its own move, not the board's.
  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0][1].items).toEqual([
    expect.objectContaining({ depth: 20, best_move_uci: 'f1c4', multipv_rank: 1 }),
  ])
  await act(() => vi.advanceTimersByTimeAsync(6_000))
  expect(post).toHaveBeenCalledTimes(1)
  unmount()
})

it('keeps an unsent review row when a deeper board search lands before the flush', async () => {
  vi.useFakeTimers()
  post.mockClear()
  post.mockResolvedValue({ data: { stored: 2 } })
  useEngineStore.setState({ analysisByFen: {}, analysisVersion: 0 })
  const { unmount } = renderHook(() => useEngineEvalSync())
  const review: CachedEngineAnalysis = {
    bestMove: 'f1c4',
    depth: 20,
    engine: 'stockfish-19',
    lines: [searched(20, 'f1c4')],
  }
  act(() => {
    useEngineStore.setState((state) => ({
      analysisByFen: { [REVIEWED_FEN]: review },
      analysisVersion: state.analysisVersion + 1,
    }))
  })
  // Within the same three seconds the player studies the position on the board.
  act(() => {
    useEngineStore.setState((state) => ({
      analysisByFen: {
        [REVIEWED_FEN]: mergeEngineAnalysis<CachedEngineAnalysis>(review, {
          bestMove: 'g1f3',
          depth: 28,
          engine: 'stockfish-19',
          lines: [searched(28, 'g1f3')],
        }),
      },
      analysisVersion: state.analysisVersion + 1,
    }))
  })
  await act(() => vi.advanceTimersByTimeAsync(3_000))
  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0][1].items).toEqual([
    expect.objectContaining({ depth: 20, best_move_uci: 'f1c4', multipv_rank: 1 }),
    expect.objectContaining({ depth: 28, best_move_uci: 'g1f3', multipv_rank: 1 }),
  ])
  unmount()
})
