// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { RetryMistakes, useRetryStore } from '@/components/analysis/retry-mistakes'
import { SparringPanel } from '@/components/sparring/sparring-panel'
import { useChessGame } from '@/hooks/use-chess-game'
import { STARTING_FEN, useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'
import { useSparStore } from '@/store/spar-store'

import { BoardRail } from './board-rail'

vi.mock('@/components/board/move-list', () => ({
  MoveList: () => <div>Move list</div>,
}))

vi.mock('@/hooks/use-active-replay-line', () => ({
  useActiveReplayLine: () => ({
    fenHistory: ['start', 'after-e4'],
    replayMoves: [{ fen: 'after-e4', ply: 1, san: 'e4', uci: 'e2e4' }],
  }),
}))

vi.mock('@/hooks/use-engine', () => ({
  analyzeBoard: vi.fn(),
  useEngine: () => ({
    analyze: vi.fn(),
    enabled: true,
    queueReplayAnalysis: vi.fn(),
  }),
}))

vi.mock('@/hooks/use-training-mode', () => ({
  useTrainingMode: () => ({
    active: false,
    start: vi.fn(),
    status: 'idle',
  }),
}))

describe('BoardRail', () => {
  it('offers quick, deep, and line analysis actions', () => {
    render(<BoardRail />)

    expect(screen.getByRole('button', { name: /quick/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /deep/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /analyze line/i })).toBeTruthy()
  })

  it('always offers a way back to a fresh board, with the loaded thing named', () => {
    const onClear = vi.fn()
    render(<BoardRail loadedContextLabel="Clear game" onClearLoadedContext={onClear} />)
    const button = screen.getByRole('button', { name: 'Clear game and start again' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect(onClear).toHaveBeenCalledOnce()
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAppStore.getState().clearLoadedLine()
})

describe('useChessGame callback stability', () => {
  it('keeps onPieceDrag, onPieceDrop, and onSquareClick stable across renders and store updates', () => {
    const { result, rerender } = renderHook(() => useChessGame())
    const initialDrag = result.current.onPieceDrag
    const initialDrop = result.current.onPieceDrop
    const initialClick = result.current.onSquareClick

    act(() => {
      result.current.onSquareClick({ piece: 'wP', square: 'e2' })
    })
    rerender()
    expect(result.current.onPieceDrag).toBe(initialDrag)
    expect(result.current.onPieceDrop).toBe(initialDrop)
    expect(result.current.onSquareClick).toBe(initialClick)

    act(() => {
      result.current.onSquareClick({ piece: null, square: 'e4' })
    })
    expect(useAppStore.getState().moveHistory).toEqual(['e4'])
    expect(result.current.onPieceDrag).toBe(initialDrag)
    expect(result.current.onPieceDrop).toBe(initialDrop)
    expect(result.current.onSquareClick).toBe(initialClick)
  })
})

describe('useTrainingMode', () => {
  it('steps through opponent moves with jumpToIndex without rebuilding the tree and toggles drillSolving', async () => {
    vi.useFakeTimers()
    const { useTrainingMode: realUseTrainingMode } = await vi.importActual<
      typeof import('@/hooks/use-training-mode')
    >('@/hooks/use-training-mode')

    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
    const afterE5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -'
    useAppStore.getState().loadReplay([
      { ply: 1, san: 'e4', uci: 'e2e4', fen: afterE4 },
      { ply: 2, san: 'e5', uci: 'e7e5', fen: afterE5 },
    ])
    const epochBefore = useAppStore.getState().treeEpoch

    const { result } = renderHook(() => realUseTrainingMode())
    act(() => {
      result.current.start()
    })
    expect(result.current.active).toBe(true)
    expect(useAppStore.getState().drillSolving).toBe(true)
    expect(useAppStore.getState().treeEpoch).toBe(epochBefore)

    // User plays 1. e4, then opponent auto-plays 1... e5 after 400ms without bumping treeEpoch.
    act(() => {
      useAppStore.getState().pushPosition(afterE4, 'e4', 'e2e4')
    })
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(useAppStore.getState().currentFen).toBe(afterE5)
    expect(useAppStore.getState().treeEpoch).toBe(epochBefore)
    expect(result.current.status).toBe('complete')

    act(() => {
      result.current.stop()
    })
    expect(useAppStore.getState().drillSolving).toBe(false)
  })
})

describe('SparringPanel takeBack', () => {
  it('truncates the taken-back branch and switches the running clock back to the player', () => {
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
    useAppStore.getState().loadPosition(STARTING_FEN)
    const epoch = useAppStore.getState().treeEpoch
    useSparStore.getState().setTimeControl(300)
    useSparStore.getState().start({
      userColor: 'white',
      elo: 1500,
      rated: true,
      epoch,
      fen: STARTING_FEN,
    })

    // White plays 1. e4 and clock switches to Black (Stockfish).
    const started = useSparStore.getState().turnStartedAt!
    act(() => {
      useAppStore.getState().pushPosition(afterE4, 'e4', 'e2e4')
      useSparStore.getState().chargeMove('white', started + 2000, afterE4)
    })
    expect(useSparStore.getState().clockSide).toBe('black')

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <SparringPanel onBeforeNewGame={vi.fn()} username="tester" />
      </QueryClientProvider>,
    )
    expect(screen.getByText('Stockfish is thinking…')).toBeTruthy()

    // Click Take back: branch is truncated so root is a leaf again, status says "Your move", and White's clock runs.
    fireEvent.click(screen.getByRole('button', { name: /Take back/i }))
    expect(screen.getByText('Your move')).toBeTruthy()
    expect(screen.queryByText('Looking back through the game')).toBeNull()
    expect(useSparStore.getState().clockSide).toBe('white')
    expect(useSparStore.getState().rated).toBe(false)
    expect(useAppStore.getState().nodes[useAppStore.getState().currentNodeId]?.children).toEqual([])
    client.clear()
    useSparStore.getState().close()
  })
})

describe('RetryMistakes timer cleanup', () => {
  it('clears the 700ms same-move rollback timer when closed', () => {
    vi.useFakeTimers()
    useEngineStore.setState({ playMove: vi.fn().mockResolvedValue([]) })
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
    const afterE5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -'
    useAppStore.getState().loadReplay([
      { ply: 1, san: 'e4', uci: 'e2e4', fen: afterE4 },
      { ply: 2, san: 'e5', uci: 'e7e5', fen: afterE5 },
    ])
    const returnNodeId = useAppStore.getState().mainLine[1]!

    act(() => {
      useRetryStore.getState().start({
        gameKey: 'g1',
        returnNodeId,
        items: [
          {
            ply: 1,
            fenBefore: STARTING_FEN,
            parentNodeId: 'root',
            lastUci: null,
            san: 'e4',
            uci: 'e2e4',
            bestUci: 'd2d4',
            label: 'Mistake',
            cpLoss: 150,
          },
        ],
      })
    })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <RetryMistakes />
      </QueryClientProvider>,
    )
    // Play the same mistake move (schedules 700ms jumpToNode('root')).
    act(() => {
      useAppStore.getState().pushPosition(afterE4, 'e4', 'e2e4')
    })

    // Close retry before 700ms elapses: board jumps to returnNodeId and must stay there.
    fireEvent.click(screen.getByRole('button', { name: 'Stop retrying' }))
    expect(useAppStore.getState().currentNodeId).toBe(returnNodeId)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(useAppStore.getState().currentNodeId).toBe(returnNodeId)
    client.clear()
  })
})
