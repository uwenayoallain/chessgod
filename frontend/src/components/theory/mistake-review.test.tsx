// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import type { Mistake } from '@/hooks/use-family-detail'

import { MistakeReview } from './mistake-review'

function mistake(extra: Partial<Mistake>): Mistake {
  return {
    parent_fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    ply: 12,
    user_move: { san: 'Qh5', uci: 'd1h5', game_count: 3, win_rate: 0.3 },
    best_move: { san: 'Nf3', uci: 'g1f3', game_count: 0, win_rate: null },
    eval_drop_cp: 320,
    severity: 'blunder',
    occurrences: 3,
    family_id: 1,
    family_name: 'Italian Game',
    ...extra,
  }
}

const mistakes = [
  mistake({}),
  mistake({
    severity: 'mistake',
    user_move: { san: 'h3', uci: 'h2h3', game_count: 2, win_rate: 0.5 },
    eval_drop_cp: 150,
  }),
  mistake({
    family_id: 2,
    family_name: 'Sicilian Defense',
    severity: 'mistake',
    user_move: { san: 'a3', uci: 'a2a3', game_count: 2, win_rate: 0.5 },
  }),
]

describe('MistakeReview', () => {
  afterEach(() => {
    cleanup()
  })

  it('draws the open and closed state as an icon beside the name, not a text glyph', () => {
    const { container } = render(<MistakeReview mistakes={mistakes} />)
    const group = screen.getByRole('button', { name: /Italian Game/ })

    expect(container.textContent).not.toMatch(/[▸▾]/)
    expect(group.getAttribute('aria-expanded')).toBe('false')
    expect(group.querySelector('svg.lucide-chevron-right')).not.toBeNull()
    // The name keeps its own element: it is a two-line clamp box, and an icon
    // inside it would stack above the text.
    expect(screen.getByTitle('Italian Game').textContent).toBe('Italian Game')
    expect(screen.getByTitle('Italian Game').querySelector('svg')).toBeNull()

    fireEvent.click(group)

    expect(group.getAttribute('aria-expanded')).toBe('true')
    expect(group.querySelector('svg.lucide-chevron-down')).not.toBeNull()
    expect(group.querySelector('svg.lucide-chevron-right')).toBeNull()
    expect(screen.getByText('Qh5')).toBeTruthy()
  })

  it('colors the counts with the text tokens, which pass contrast where the fills do not', () => {
    render(<MistakeReview mistakes={mistakes} />)

    const blunders = screen.getByText('1 blunder')
    const count = screen.getAllByText('1 mistake')[0]
    expect(blunders.getAttribute('style')).toContain('var(--danger-text)')
    expect(count.getAttribute('style')).toContain('var(--warning-text)')
  })
})
