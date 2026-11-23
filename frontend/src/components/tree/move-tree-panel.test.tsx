// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vite-plus/test'

import { MoveTreePanel } from './move-tree-panel'

vi.mock('@/hooks/use-opening-tree', () => ({
  useOpeningTree: () => ({
    data: {
      black_wins: 0,
      draws: 0,
      fen: 'start',
      moves: [
        {
          black_wins: 0,
          draws: 0,
          game_count: 3,
          resulting_fen: 'after-e4',
          san: 'e4',
          uci: 'e2e4',
          white_wins: 3,
        },
      ],
      total_games: 3,
      white_wins: 3,
    },
    error: null,
    isLoading: false,
    isRefreshing: true,
  }),
}))

vi.mock('@/store/app-store', () => ({
  useAppStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      colorFilter: 'both',
      currentFen: 'start',
      pushPosition: vi.fn(),
      timeClassFilter: null,
    }),
  ),
}))

describe('MoveTreePanel', () => {
  it('keeps tree rows mounted while a position refresh is in flight', () => {
    render(<MoveTreePanel />)

    expect(screen.getByText('Updating')).toBeTruthy()
    expect(screen.getByText('e4')).toBeTruthy()
    expect(screen.queryByText('End of Theory')).toBeNull()
  })
})
