import { describe, expect, it } from 'vite-plus/test'

import { describeAccuracy, describeCoverage, describeSessionEstimate } from './session-summary'

describe('describeCoverage', () => {
  it('says how often a repeating theme actually repeated', () => {
    expect(describeCoverage({ positions: 113, occurrences: 114 })).toBe(
      '113 positions, seen 114 times',
    )
  })

  it('does not print the same number twice', () => {
    // "12 positions · 12 times seen" reads as a bug, not as information.
    expect(describeCoverage({ positions: 12, occurrences: 12 })).toBe('12 positions')
  })

  it('reads as a sentence for a single position', () => {
    expect(describeCoverage({ positions: 1, occurrences: 1 })).toBe('1 position')
  })
})

describe('describeAccuracy', () => {
  it('says what the percentage is a share of', () => {
    // A flat "0% drill accuracy" does not say whether that is one wrong answer
    // or a hundred.
    expect(describeAccuracy({ drill_attempts: 3, drill_correct_rate: 0 })).toBe(
      '0% correct over 3 tries',
    )
    expect(describeAccuracy({ drill_attempts: 1, drill_correct_rate: 1 })).toBe(
      '100% correct over 1 try',
    )
  })

  it('never shows a percentage before anything was attempted', () => {
    expect(describeAccuracy({ drill_attempts: 0, drill_correct_rate: null })).toBe(
      'not drilled yet',
    )
    // A rate with no attempts behind it is not a rate.
    expect(describeAccuracy({ drill_attempts: 0, drill_correct_rate: 0 })).toBe('not drilled yet')
  })
})

describe('describeSessionEstimate', () => {
  it('explains where the minutes come from and why the set stops short', () => {
    const text = describeSessionEstimate({
      drillCount: 10,
      sessionSeconds: 440,
      availablePositions: 113,
    })
    expect(text).toContain('10 of 113 positions')
    expect(text).toContain('about 7 min')
    expect(text).toContain('ten-minute session')
  })

  it('does not claim a subset when it is showing everything', () => {
    expect(
      describeSessionEstimate({ drillCount: 3, sessionSeconds: 120, availablePositions: 3 }),
    ).toContain('3 positions, about 2 min')
  })
})
