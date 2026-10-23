import { describe, expect, it } from 'vite-plus/test'

import { describeRatingGoal } from './rating'
import type { RatingGoal } from './types'

const base: RatingGoal = {
  time_class: 'rapid',
  goal: 1800,
  current: 1669,
  change_30d: 55,
  peak: 1777,
  peak_at: '2026-07-04',
  pace_per_month: -40.1,
  pace_games: 146,
  eta: null,
  vs_goal: { games: 64, score: 0.328 },
  vs_level: { games: 306, score: 0.511 },
  band: 75,
  points: [],
}

describe('rating goal', () => {
  it('does not promise a date when the pace is falling', () => {
    const words = describeRatingGoal(base)
    expect(words.headline).toBe(
      '131 points to go. No steady climb yet: -40 a month over 90 days. The last 30 days are +55, though.',
    )
    expect(words.detail).toBe(
      'Against players around 1800 you score 33% (64 games). Players rated 1800 score about 50%. At your own level you score 51%.',
    )
  })

  it('gives a month for a real climb, and says when the goal is met', () => {
    const climbing = describeRatingGoal({ ...base, pace_per_month: 30, eta: '2027-02-10' })
    expect(climbing.headline).toMatch(/^At \+30 a month, you reach 1800 around /)
    expect(describeRatingGoal({ ...base, current: 1810 }).headline).toBe(
      'You made it: 1810. Pick a higher goal.',
    )
    expect(describeRatingGoal({ ...base, vs_goal: { games: 3, score: null } }).detail).toContain(
      'Too few games against players around 1800',
    )
  })
})
