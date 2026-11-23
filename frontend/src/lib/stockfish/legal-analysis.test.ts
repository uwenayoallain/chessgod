import { describe, expect, it } from 'vite-plus/test'

import { getTerminalOutcome, isLegalEngineMove, isLegalEngineLine } from './legal-analysis'
import type { UCIInfo } from './uci'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'

function line(pv: string[]): UCIInfo {
  return {
    depth: 12,
    multipv: 1,
    nodes: null,
    nps: null,
    pv,
    score: { type: 'cp', value: 20 },
    seldepth: null,
    time: null,
  }
}

describe('legal Stockfish analysis guards', () => {
  it('rejects mate-zero scores paired with a playable variation', () => {
    expect(
      isLegalEngineLine(START_FEN, {
        ...line(['e2e4']),
        score: { type: 'mate', value: 0 },
      }),
    ).toBe(false)
  })

  it.each([-3, 3])('keeps truncated variations with nonzero mate scores (%s)', (value) => {
    expect(
      isLegalEngineLine(START_FEN, {
        ...line(['e2e4']),
        score: { type: 'mate', value },
      }),
    ).toBe(true)
  })

  it('recognizes mate and stalemate without guessing draw claims from a FEN', () => {
    expect(getTerminalOutcome('k7/1Q6/2K5/8/8/8/8/8 b - -')).toEqual({
      whiteResult: 1,
      reason: 'checkmate',
    })
    expect(getTerminalOutcome('8/8/8/8/8/2k5/1q6/K7 w - -')).toEqual({
      whiteResult: -1,
      reason: 'checkmate',
    })
    expect(getTerminalOutcome('k7/2Q5/2K5/8/8/8/8/8 b - -')).toEqual({
      whiteResult: 0,
      reason: 'stalemate',
    })
    expect(getTerminalOutcome(`${START_FEN} 100 90`)).toBeNull()
    expect(getTerminalOutcome('invalid')).toBeNull()
  })
  it('accepts legal best moves for the current FEN', () => {
    expect(isLegalEngineMove(START_FEN, 'e2e4')).toBe(true)
  })

  it('rejects stale best moves that are illegal in the current FEN', () => {
    expect(isLegalEngineMove(AFTER_E4, 'e2e4')).toBe(false)
  })

  it('rejects stale PV lines that cannot be played from the current FEN', () => {
    expect(isLegalEngineLine(AFTER_E4, line(['e2e4', 'e7e5']))).toBe(false)
  })
})
