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

  it('leads with improving form when the 90-day line is flat', () => {
    const words = describeRatingGoal({
      ...base,
      current: 1687,
      goal: 2000,
      change_30d: 0,
      pace_per_month: -3,
      vs_goal: { games: 0, score: null },
      vs_higher: { games: 24, score: 0.375 },
      form: {
        games: 20,
        wins: 12,
        draws: 1,
        losses: 7,
        score: 0.625,
        rating_change: 41,
        performance: 1765,
        days: 9,
      },
    })
    expect(words.headline).toContain('your recent form is up. +41 over your last 20 games.')
    expect(words.detail).toBe(
      'Playing at about 1765 lately (12-1-7 in your last 20). Against players rated 50 to 250 above you, you score 38% (24 games). At your own level you score 51%.',
    )
  })

  it('keeps the date for a climb and still names recent form', () => {
    const words = describeRatingGoal({
      ...base,
      pace_per_month: 30,
      eta: '2027-02-10',
      form: {
        games: 8,
        wins: 5,
        draws: 0,
        losses: 3,
        score: 0.625,
        rating_change: 12,
        performance: 1720,
        days: 6,
      },
    })
    expect(words.headline).toMatch(/^At \+30 a month, you reach 1800 around /)
    expect(words.detail).toContain('Playing at about 1720 lately (5-0-3 in your last 8).')
  })

  it('does not call a cold stretch improving', () => {
    const words = describeRatingGoal({
      ...base,
      form: {
        games: 10,
        wins: 2,
        draws: 0,
        losses: 8,
        score: 0.2,
        rating_change: -30,
        performance: 1500,
        days: 5,
      },
    })
    expect(words.headline).toContain('No steady climb yet')
    expect(words.headline).not.toContain('recent form is up')
  })
})
