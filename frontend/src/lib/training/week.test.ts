import { describe, expect, it } from 'vite-plus/test'

import type { WeekScoresheet } from './types'
import { habitsLine, ratingLines, weekLine } from './week'

const sheet: WeekScoresheet = {
  week: '2026-09-21',
  ends: '2026-09-27',
  games: [],
  played: 12,
  wins: 5,
  draws: 1,
  losses: 6,
  score: 0.458,
  ratings: { rapid: { from: 1694, to: 1692 } },
  best_win: null,
  in_book: 6,
  book_games: 11,
  clock_used: 1,
  xp: 0,
}

describe('week scoresheet', () => {
  it('sums the week in one line', () => {
    expect(weekLine(sheet)).toBe('12 games · 5–1–6 · 46%')
    expect(weekLine({ ...sheet, played: 0 })).toBe('No rapid or blitz games this week.')
  })

  it('says how each rating moved and what the training aimed at', () => {
    expect(ratingLines(sheet)).toEqual(['Rapid 1694 → 1692 (−2)'])
    expect(habitsLine(sheet)).toBe(
      '6 of 11 followed your repertoire · good clock use in 1 · no training.',
    )
  })
})
