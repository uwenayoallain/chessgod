// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vite-plus/test'

import { GameListPanel } from './game-list-panel'

vi.mock('@/hooks/use-workspace-data', () => ({
  usePaginatedGames: () => ({
    data: {
      games: [
        {
          id: 1,
          chesscom_game_url: 'https://chess.com/game/1',
          username: 'tester',
          white_username: 'tester',
          black_username: 'opponent',
          white_rating: 1200,
          black_rating: 1300,
          user_color: 'white',
          result: '1-0',
          user_result: 'win',
          time_class: 'blitz',
          eco: 'C20',
          opening_name: 'King Pawn Game',
          played_at: '2024-01-02T00:00:00Z',
          num_moves: 20,
          pgn: '',
          has_analysis: true,
        },
      ],
      total: 1,
      page: 1,
      per_page: 20,
    },
    isLoading: false,
    isRefreshing: false,
    error: null,
  }),
}))

describe('GameListPanel', () => {
  it('marks games that already have saved analysis', () => {
    render(
      <GameListPanel
        color="both"
        currentFen="start"
        eco={null}
        onSelectGame={vi.fn()}
        openingName={null}
        selectedGameId={null}
        timeClass={null}
        username="tester"
      />,
    )

    expect(screen.getByText('Analyzed')).toBeTruthy()
  })
})
