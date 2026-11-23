import { describe, expect, it } from 'vite-plus/test'

import { shouldAutoAnalyze } from './auto-analysis'

describe('shouldAutoAnalyze', () => {
  it('does not start an engine on a game that has not begun', () => {
    // Opening the app used to fire a full-depth search of the opening position
    // before any game was loaded.
    expect(shouldAutoAnalyze('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -')).toBe(false)
  })

  it('ignores the move counters, which are not what makes it the start', () => {
    expect(shouldAutoAnalyze('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe(
      false,
    )
  })

  it('analyses a real position', () => {
    expect(shouldAutoAnalyze('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -')).toBe(true)
  })

  it('treats a same-looking board with a move played as a real position', () => {
    // Black to move from the start placement is not the starting position.
    expect(shouldAutoAnalyze('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq -')).toBe(true)
  })

  it('has nothing to analyse without a position', () => {
    expect(shouldAutoAnalyze(null)).toBe(false)
    expect(shouldAutoAnalyze('')).toBe(false)
  })
})
