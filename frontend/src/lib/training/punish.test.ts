import { describe, expect, it } from 'vite-plus/test'

import { punishLesson, punishPrompt, punishSummary } from './rush'

describe('Punish it copy', () => {
  it("names the opponent's move with the right move number for either side", () => {
    // The player's move is ply 23 (White's 12th), so the mistake was Black's 11th.
    expect(punishPrompt({ their_move_san: 'd5', kind: 'capture', ply: 23 })).toBe(
      'Your opponent played 11...d5, a mistake. You can win material. Find your move.',
    )
    expect(punishPrompt({ their_move_san: 'Rc1+', kind: 'capture', ply: 88 })).toBe(
      'Your opponent played 44.Rc1+, a mistake. You can win material. Find your move.',
    )
  })

  it('says what was played in the game either way', () => {
    const answer = { answer_san: 'Bxc1', your_move_san: 'Kg2' }
    expect(punishLesson({ ...answer, correct: true }, 'Bxc1')).toBe(
      'Found: Bxc1. In the game you played Kg2 and gave it back.',
    )
    expect(punishLesson({ ...answer, correct: false }, 'Kh1')).toMatch(
      /^Kh1 isn't it\. Bxc1 punishes it\./,
    )
    expect(punishSummary(10, 10)).toMatch(/^All 10 found/)
  })
})
