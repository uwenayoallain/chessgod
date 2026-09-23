// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vite-plus/test'

import { TheoryComparison } from './theory-comparison'

describe('TheoryComparison', () => {
  it('shows source state, counts, and win rates for user and master moves', () => {
    render(
      <TheoryComparison
        data={{
          eco: 'C20',
          fen: 'start',
          master_data_state: 'seeded',
          master_moves: [{ game_count: 15000, san: 'e4', uci: 'e2e4', win_rate: 0.55 }],
          opening_name: 'King Pawn Game',
          user_moves: [{ game_count: 12, san: 'd4', uci: 'd2d4', win_rate: 0.42 }],
        }}
      />,
    )

    expect(screen.getByText('Seeded book')).toBeTruthy()
    expect(screen.getByText('12 games')).toBeTruthy()
    expect(screen.getByText('42%')).toBeTruthy()
    expect(screen.getByText('15k games')).toBeTruthy()
    expect(screen.getByText('55%')).toBeTruthy()
  })
})
