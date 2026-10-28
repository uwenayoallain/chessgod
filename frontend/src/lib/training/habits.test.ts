import { describe, expect, it } from 'vite-plus/test'

import { describeHabit, describeMoment, describeSitting, orderHabits } from './habits'
import type { Habit } from './types'

const second: Habit = {
  key: 'second_mistake',
  shows: true,
  events: 4806,
  rate: 0.236,
  baseline: 0.101,
  recent_rate: 0.167,
  recent_events: 84,
}
const session: Habit = {
  key: 'long_session',
  shows: true,
  stop_after: 4,
  early: 0.038,
  late: -0.034,
  drop: 0.072,
}
const tilt: Habit = { key: 'tilt', shows: false, games: 358, after_loss: 0.05, otherwise: 0.012 }

describe('describeHabit', () => {
  it("states the habit in the player's own numbers and says when it is getting better", () => {
    const words = describeHabit(second)
    expect(words.line).toBe(
      'After a big mistake, the next move is another one 24% of the time. Other moves: 10%.',
    )
    expect(words.recent).toEqual({ text: 'Last 30 games: 17%. Better lately.', tone: 'good' })
    expect(words.advice).toMatch(/30 seconds/)
  })

  it('does not call a trend from a handful of recent moves', () => {
    expect(describeHabit({ ...second, recent_events: 5 }).recent).toBeNull()
  })

  it('reports a habit the player does not have as good news, with no advice', () => {
    const words = describeHabit(tilt)
    expect(words.title).toBe('A loss does not tilt you')
    expect(words.line).toMatch(/5 points above your rating/)
    expect(words.advice).toBeNull()
  })

  it('names the sitting length to stop at', () => {
    const words = describeHabit(session)
    expect(words.line).toBe(
      'Your first 4 games in a sitting score 4 points above your rating. From game 5 on: 3 points below your rating.',
    )
    expect(words.advice).toBe(
      'Stop after 4 games in a row and take a break of at least 30 minutes.',
    )
  })
})

describe('orderHabits', () => {
  it('puts the habits the player has first', () => {
    expect(orderHabits([tilt, second]).map((habit) => habit.key)).toEqual([
      'second_mistake',
      'tilt',
    ])
  })
})

describe('describeSitting', () => {
  const sitting = (games: number, active = true) => ({
    habits: [session],
    sitting: { active, games, results: [] },
  })

  it('says stop once the sitting reaches the length where games start to cost', () => {
    expect(describeSitting(sitting(4))).toEqual({
      text: '4 games in a row. After game 4 you score 3 points below your rating. A good place to stop.',
      stop: true,
    })
  })

  it('counts down before then', () => {
    expect(describeSitting(sitting(3))?.text).toBe(
      'Game 3 of this sitting. Your best are the first 4: one more, then stop.',
    )
  })

  it('says nothing between sittings or when long sittings cost nothing', () => {
    expect(describeSitting(sitting(5, false))).toBeNull()
    expect(
      describeSitting({ habits: [{ ...session, shows: false }], sitting: sitting(6).sitting }),
    ).toBeNull()
  })
})

describe('describeMoment', () => {
  it("names the opponent's mistake, the reply and the move that kept it", () => {
    expect(
      describeMoment({
        kind: 'missed_punishment',
        ply: 44,
        move_number: 22,
        san: 'Kh8',
        better_san: 'Kxh7',
        opponent_san: 'Bxh7+',
        think_seconds: 1.4,
        fen: null,
      }),
    ).toBe('Move 22: their Bxh7+ was a mistake, and you answered Kh8 in 1s. Kxh7 was the move.')
  })
})
