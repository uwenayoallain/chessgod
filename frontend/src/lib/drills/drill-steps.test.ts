import { describe, expect, it } from 'vite-plus/test'

import { drillLine, drillStep, drillStepCount, drillStepLabel } from './drill-steps'

const single = { best_move_san: 'Nxe5', best_move_uci: 'f3e5', follow_up: null }

const twoMove = {
  best_move_san: 'Nxe5',
  best_move_uci: 'f3e5',
  follow_up: {
    fen: 'x',
    opponent_reply_san: 'Bxd1',
    opponent_reply_uci: 'c2d1',
    best_move_san: 'Rxd1',
    best_move_uci: 'a1d1',
  },
}

describe('drill steps', () => {
  it('counts the plies the player is asked for', () => {
    expect(drillStepCount(single)).toBe(1)
    expect(drillStepCount(twoMove)).toBe(2)
  })

  it('asks for the follow-up once the first move is found', () => {
    const step = drillStep(twoMove, 'follow-up')
    expect(step.index).toBe(2)
    // The move they are stuck on now, not the one they already played.
    expect(step.answerSan).toBe('Rxd1')
    expect(step.answerUci).toBe('a1d1')
  })

  it('asks for the first move while solving', () => {
    expect(drillStep(twoMove, 'solving').answerSan).toBe('Nxe5')
  })

  it('never indexes past a card that has no follow-up', () => {
    // A status left over from the previous card must not read off the end.
    const step = drillStep(single, 'follow-up')
    expect(step.index).toBe(1)
    expect(step.answerSan).toBe('Nxe5')
  })

  it('labels the step only when there is more than one', () => {
    expect(drillStepLabel(drillStep(twoMove, 'follow-up'))).toBe('Move 2 of 2')
    expect(drillStepLabel(drillStep(twoMove, 'solving'))).toBe('Move 1 of 2')
    expect(drillStepLabel(drillStep(single, 'solving'))).toBeNull()
  })

  it('marks which ply of the line was being asked for', () => {
    // "The line runs Nxe5 Bxd1 Rxd1" does not say which one you were stuck on,
    // and that is the only part the reader is missing.
    expect(drillLine(twoMove, 2)).toEqual([
      { san: 'Nxe5', side: 'player', isAnswer: false },
      { san: 'Bxd1', side: 'opponent', isAnswer: false },
      { san: 'Rxd1', side: 'player', isAnswer: true },
    ])
    expect(drillLine(twoMove, 1)[0].isAnswer).toBe(true)
    expect(drillLine(twoMove, 1)[2].isAnswer).toBe(false)
  })

  it('gives a single-move drill a one-ply line', () => {
    expect(drillLine(single, 1)).toEqual([{ san: 'Nxe5', side: 'player', isAnswer: true }])
  })
})
