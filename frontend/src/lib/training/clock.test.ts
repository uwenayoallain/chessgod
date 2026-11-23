import { describe, expect, it } from 'vite-plus/test'

import { challengesStale } from './challenges'
import { controlName, describeClock, describeFinish, formatClock } from './clock'
import type { ChallengeBoard, ClockReport } from './types'

const report: ClockReport = {
  username: 'saint_uwe',
  verdict: 'unused',
  time_control: '600',
  time_class: 'rapid',
  initial_seconds: 600,
  increment: 0,
  games: 300,
  losses: 136,
  left_in_losses: 359.2,
  left_in_wins: 379.7,
  mistakes: 1153,
  mistake_think: 6.6,
  mistake_left: 471.9,
  mistakes_with_half_clock: 0.872,
  hasty_mistakes: 0.566,
  mistakes_in_time_trouble: 0.014,
  by_finish: [
    { label: 'Half or more', games: 100, score: 0.48 },
    { label: '30-50%', games: 78, score: 0.455 },
    { label: '10-30%', games: 33, score: 0.53 },
    { label: 'Under 10%', games: 9, score: 0.222 },
  ],
}

describe('clock', () => {
  it('formats clocks and controls the way players say them', () => {
    expect(formatClock(359.2)).toBe('5:59')
    expect(formatClock(45)).toBe('0:45')
    expect(controlName(report)).toBe('10-minute')
    expect(controlName({ ...report, initial_seconds: 180, increment: 2 })).toBe('3+2')
  })

  it('says the time is there when the mistakes come with the clock full', () => {
    const words = describeClock(report)
    expect(words.headline).toBe('You lose 10-minute games with 5:59 of 10:00 still on your clock.')
    expect(words.detail).toContain('87% of your big mistakes came with half your clock or more')
    expect(words.detail).toContain('The typical one took 7 seconds, with 7:52 left.')
    expect(words.advice).toContain('What does it allow?')
  })

  it('gives time trouble the opposite advice', () => {
    const words = describeClock({
      ...report,
      verdict: 'time_trouble',
      mistakes_in_time_trouble: 0.3,
    })
    expect(words.headline).toBe('You get into time trouble.')
    expect(words.advice).toContain('save a minute for the end')
    expect(describeClock({ ...report, verdict: 'insufficient' }).advice).toBeNull()
  })

  it('compares the best finish with the usual one, ignoring thin bands', () => {
    expect(describeFinish(report)).toBe(
      'Games past move 30: 53% with 10-30% of the clock left, 48% with half or more, where most of yours end.',
    )
    expect(describeFinish({ ...report, by_finish: report.by_finish!.slice(0, 1) })).toBeNull()
  })

  it('flags challenges counted from an old import', () => {
    const board = { latest_game: '2026-09-12T14:09:56+00:00' } as ChallengeBoard
    expect(challengesStale(board, new Date('2026-09-30T12:00:00Z'))).toBe(true)
    expect(challengesStale(board, new Date('2026-09-12T20:00:00Z'))).toBe(false)
    expect(challengesStale({ latest_game: null } as ChallengeBoard, new Date())).toBe(true)
  })
})
