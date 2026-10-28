// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vite-plus/test'

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
