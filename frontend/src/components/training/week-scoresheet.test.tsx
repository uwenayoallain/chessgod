// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { WeekScoresheet as Sheet } from '@/lib/training/types'
import { weekLabel } from '@/lib/training/week'

import { WeekScoresheet } from './week-scoresheet'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/lib/api', () => ({ api: { get } }))

function sheet(week: string, ends: string, played: number): Sheet {
  return {
    week,
    ends,
    games: [],
    played,
    wins: played,
    draws: 0,
    losses: 0,
    score: played ? 1 : null,
    ratings: {},
    best_win: null,
    in_book: 0,
    book_games: 0,
    clock_used: 0,
    xp: 0,
  }
}

const lastWeek = sheet('2026-11-09', '2026-11-15', 4)
const thisWeek = sheet('2026-11-16', '2026-11-22', 2)

/** A request the test answers by hand, so the wait can be looked at. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <WeekScoresheet username="tester" />
    </QueryClientProvider>,
  )
}

describe('WeekScoresheet', () => {
  beforeEach(() => {
    get.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('says the chosen week is loading until it arrives, instead of showing the other week as it', async () => {
    const pending = deferred<{ data: Sheet }>()
    get.mockImplementation((_url: string, config: { params: { weeks_back: number } }) =>
      config.params.weeks_back === 1 ? Promise.resolve({ data: lastWeek }) : pending.promise,
    )
    const { container } = renderSheet()

    expect(await screen.findByText(`Scoresheet · ${weekLabel(lastWeek)}`)).toBeTruthy()
    const card = container.querySelector('.scoresheet')!
    expect(card.getAttribute('aria-busy')).toBeNull()

    const chosen = screen.getByRole('button', { name: 'This week' })
    fireEvent.click(chosen)

    // The toggle answers at once, and the sheet under it owns up to being the
    // other week's rather than passing for the one just chosen.
    expect(chosen.getAttribute('aria-pressed')).toBe('true')
    expect(chosen.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('button', { name: 'Last week' }).getAttribute('aria-busy')).toBeNull()
    expect(card.getAttribute('aria-busy')).toBe('true')
    expect(card.hasAttribute('data-switching')).toBe(true)
    expect(screen.getByText('Scoresheet · Loading this week…')).toBeTruthy()
    expect(screen.queryByText(`Scoresheet · ${weekLabel(lastWeek)}`)).toBeNull()
    // The old sheet stays in place, so nothing collapses while waiting.
    expect(screen.getByText(/^4 games/)).toBeTruthy()

    pending.resolve({ data: thisWeek })

    expect(await screen.findByText(`Scoresheet · ${weekLabel(thisWeek)}`)).toBeTruthy()
    expect(screen.getByText(/^2 games/)).toBeTruthy()
    expect(card.getAttribute('aria-busy')).toBeNull()
    expect(card.hasAttribute('data-switching')).toBe(false)
    expect(chosen.getAttribute('aria-busy')).toBeNull()
  })

  it('goes back to a week already fetched without a loading state', async () => {
    get.mockImplementation((_url: string, config: { params: { weeks_back: number } }) =>
      Promise.resolve({ data: config.params.weeks_back === 1 ? lastWeek : thisWeek }),
    )
    const { container } = renderSheet()
    await screen.findByText(`Scoresheet · ${weekLabel(lastWeek)}`)

    fireEvent.click(screen.getByRole('button', { name: 'This week' }))
    await screen.findByText(`Scoresheet · ${weekLabel(thisWeek)}`)
    fireEvent.click(screen.getByRole('button', { name: 'Last week' }))

    expect(screen.getByText(`Scoresheet · ${weekLabel(lastWeek)}`)).toBeTruthy()
    expect(container.querySelector('.scoresheet')!.getAttribute('aria-busy')).toBeNull()
  })
})
