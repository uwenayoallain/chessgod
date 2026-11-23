import { describe, expect, it } from 'vite-plus/test'

import { buildContinuation, formatContinuationScore, pvToMoves } from './continuation'
import type { UCIInfo } from '@/lib/stockfish/uci'

const WHITE_TO_MOVE = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -'
const BLACK_TO_MOVE = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -'

const line = (pv: string[], score: UCIInfo['score'], depth = 22): UCIInfo => ({
  depth,
  multipv: 1,
  nodes: null,
  nps: null,
  pv,
  score,
  seldepth: null,
  time: null,
})

describe('pvToMoves', () => {
  it('converts a principal variation into playable moves', () => {
    const moves = pvToMoves(WHITE_TO_MOVE, ['g1f3', 'b8c6', 'f1b5'])
    expect(moves.map((m) => m.san)).toEqual(['Nf3', 'Nc6', 'Bb5'])
    // Each ply carries the board after it, so a reader can jump onto the line.
    expect(moves[0].fen).toContain('5N2')
  })

  it('labels whose move each ply is, from the side to move at the root', () => {
    expect(pvToMoves(WHITE_TO_MOVE, ['g1f3', 'b8c6']).map((m) => m.side)).toEqual([
      'player',
      'opponent',
    ])
    expect(pvToMoves(BLACK_TO_MOVE, ['b8c6', 'f1b5']).map((m) => m.side)).toEqual([
      'player',
      'opponent',
    ])
  })

  it('keeps what converted when a stale line stops playing', () => {
    // A PV can outlive the position it was searched from; half a line still reads.
    const moves = pvToMoves(WHITE_TO_MOVE, ['g1f3', 'a1a8'])
    expect(moves.map((m) => m.san)).toEqual(['Nf3'])
  })

  it('returns nothing rather than throwing on a broken position', () => {
    expect(pvToMoves('not-a-fen', ['g1f3'])).toEqual([])
  })
})

describe('buildContinuation', () => {
  it('reads the evaluation from the side doing the drill', () => {
    const asWhite = buildContinuation({
      rootFen: WHITE_TO_MOVE,
      line: line(['g1f3'], { type: 'cp', value: 60 }),
    })
    expect(asWhite?.scoreCp).toBe(60)

    // UCI scores are from the side to move, so Black's +60 is Black being better.
    const asBlack = buildContinuation({
      rootFen: BLACK_TO_MOVE,
      line: line(['b8c6'], { type: 'cp', value: 60 }),
    })
    expect(asBlack?.scoreCp).toBe(60)
  })

  it('stops the line at the requested length', () => {
    const c = buildContinuation({
      rootFen: WHITE_TO_MOVE,
      line: line(['g1f3', 'b8c6', 'f1b5', 'g8f6'], { type: 'cp', value: 20 }),
      maxPlies: 2,
    })
    expect(c?.moves.map((m) => m.san)).toEqual(['Nf3', 'Nc6'])
  })

  it('has nothing to show without a line', () => {
    expect(buildContinuation({ rootFen: WHITE_TO_MOVE, line: null })).toBeNull()
    expect(
      buildContinuation({ rootFen: WHITE_TO_MOVE, line: line([], { type: 'cp', value: 0 }) }),
    ).toBeNull()
  })
})

describe('formatContinuationScore', () => {
  it('reads as an evaluation', () => {
    const at = (score: UCIInfo['score'], fen = WHITE_TO_MOVE) =>
      formatContinuationScore(buildContinuation({ rootFen: fen, line: line(['g1f3'], score) })!)

    expect(at({ type: 'cp', value: 140 })).toBe('+1.4')
    expect(at({ type: 'cp', value: -30 })).toBe('−0.3')
    expect(at({ type: 'cp', value: 0 })).toBe('0.0')
    expect(at({ type: 'mate', value: 3 })).toBe('M3')
  })
})
