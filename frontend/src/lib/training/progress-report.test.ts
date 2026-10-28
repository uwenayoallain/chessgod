import { describe, expect, it } from 'vite-plus/test'

import { delta, describeProgress, describeSinceTraining, rollingBigErrors } from './progress-report'
import type { ProgressGame, ProgressSummary, TrainingProgress } from './types'

function summary(extra: Partial<ProgressSummary>): ProgressSummary {
  return {
    games: 20,
    big_errors: 5,
    forcing_errors: 1.75,
    score: 0.4,
    worse_after_opening: { black: 0.36 },
    rating_from: 1617,
    rating_to: 1590,
    ...extra,
  }
}

// The first real corpus: more big mistakes, but better results.
const measured: TrainingProgress = {
  username: 'saint_uwe',
  checked_games: 80,
  games: [],
  recent: summary({
    big_errors: 6.45,
    forcing_errors: 2.55,
    score: 0.75,
    rating_from: 1598,
    rating_to: 1669,
  }),
  previous: summary({}),
  training_since: null,
  since_training: null,
  before_training: null,
}

describe('describeProgress', () => {
  it('says so when results and mistakes point different ways', () => {
    const report = describeProgress(measured)
    expect(report.headline).toBe('More big mistakes lately: 6.5 a game, up from 5.0.')
    expect(report.detail).toMatch(/^Your results are up anyway/)
  })

  it('credits fewer mistakes and points at the forcing ones', () => {
    const report = describeProgress({
      ...measured,
      recent: summary({ big_errors: 3.9, forcing_errors: 1.2 }),
    })
    expect(report.headline).toBe('Fewer big mistakes: 3.9 a game, down from 5.0.')
    expect(report.detail).toMatch(/^1\.2 a game were a capture or check/)
  })

  it('calls a small change the same', () => {
    expect(describeProgress({ ...measured, recent: summary({ big_errors: 5.2 }) }).headline).toBe(
      'About the same: 5.2 big mistakes a game, against 5.0 before.',
    )
  })

  it('refuses a trend without two full windows', () => {
    const report = describeProgress({
      ...measured,
      previous: null,
      games: Array.from({ length: 25 }) as ProgressGame[],
    })
    expect(report.headline).toBe('Not enough analyzed games for a trend yet.')
    expect(report.detail).toBe('Needs 40 analyzed games. 25 of your last 80 are.')
  })
})

it('describeSinceTraining waits for five games after training started', () => {
  const since = { ...measured, since_training: summary({ games: 4 }), before_training: summary({}) }
  expect(describeSinceTraining(since)).toBeNull()
  expect(
    describeSinceTraining({ ...since, since_training: summary({ games: 8, big_errors: 3.1 }) }),
  ).toBe('Since training began (8 games): 3.1 big mistakes a game, 5.0 before.')
})

it('delta says which way is good', () => {
  expect(delta(3.9, 5, { lowerIsBetter: true })).toEqual({ text: '↓ 1.1', good: true })
  expect(delta(1669, 1598, { lowerIsBetter: false, digits: 0 })).toEqual({
    text: '↑ 71',
    good: true,
  })
  expect(delta(6.45, 5, { lowerIsBetter: true })).toEqual({ text: '↑ 1.5', good: false })
  expect(delta(5, 5, { lowerIsBetter: true })).toEqual({ text: 'same', good: null })
  expect(delta(5, null, { lowerIsBetter: true })).toEqual({ text: '—', good: null })
})

it('rollingBigErrors averages the last ten games, oldest first', () => {
  const games = [4, 0, 2].map((big, index) => ({ game_id: index, big_errors: big }) as ProgressGame)
  // Newest first in, oldest first out: 2, then (2+0)/2, then (2+0+4)/3.
  expect(rollingBigErrors(games).map((point) => point.value)).toEqual([2, 1, 2])
})
