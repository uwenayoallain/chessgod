// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import type { GameStats } from '@/hooks/use-game-stats'

import { ColorBreakdown } from './color-breakdown'
import { ResyncButton } from './resync-button'
import { StatsOverview } from './stats-overview'

const { importState } = vi.hoisted(() => ({
  importState: { status: 'idle', error: null as string | null },
}))

vi.mock('@/hooks/use-import', () => ({
  useImport: () => ({ ...importState, startImport: vi.fn(), stopImport: vi.fn() }),
}))

const stats: GameStats = {
  total_games: 30,
  win_rate: 0.5,
  by_color: {
    white: { wins: 11, losses: 3, draws: 2 },
    black: { wins: 4, losses: 7, draws: 3 },
  },
  by_time_class: {},
  by_opening: [],
} as GameStats

/**
 * --danger and --success are fills: as text they fall under 4.5:1 on the
 * light surfaces. Text reads the tokens made for it.
 */
function color(element: Element | null) {
  return element?.getAttribute('style') ?? ''
}

describe('result colors', () => {
  afterEach(() => {
    cleanup()
    importState.status = 'idle'
    importState.error = null
  })

  it('writes wins and losses by color in the text tokens', () => {
    render(<ColorBreakdown stats={stats} />)

    expect(color(screen.getByText('11W'))).toContain('var(--accent-text)')
    expect(color(screen.getByText('3L'))).toContain('var(--danger-text)')
    expect(color(screen.getByText('4W'))).toContain('var(--accent-text)')
    expect(color(screen.getByText('7L'))).toContain('var(--danger-text)')
  })

  it('writes the overview totals in the text tokens', () => {
    render(<StatsOverview stats={stats} />)

    expect(color(screen.getByText('15'))).toContain('var(--accent-text)')
    expect(color(screen.getByText('10'))).toContain('var(--danger-text)')
  })

  it('writes a failed sync and a finished one in the text tokens', () => {
    importState.error = 'Chess.com did not answer'
    const { rerender } = render(<ResyncButton username="tester" />)
    expect(color(screen.getByText('Chess.com did not answer'))).toContain('var(--danger-text)')

    importState.error = null
    importState.status = 'complete'
    rerender(<ResyncButton username="tester" />)
    expect(color(screen.getByText('Up to date'))).toContain('var(--accent-text)')
  })
})
