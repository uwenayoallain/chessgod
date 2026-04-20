import { describe, expect, it } from 'vitest'

import { isLegalEngineMove, isLegalEngineLine } from './legal-analysis'
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
