import { describe, expect, it } from 'vite-plus/test'

import {
  applyUciMove,
  CALIBRATION_RATING,
  chooseBookMove,
  chooseSparMove,
  sparSearchParams,
  describeOutcome,
  nextSparElo,
  sparMoveTimeMs,
  sparOutcome,
  sideToMove,
  startingSparElo,
} from './sparring'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
// Fool's mate: White to move and checkmated.
const WHITE_MATED = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq -'

describe('sparOutcome', () => {
  it('reports a checkmate from the player’s side', () => {
    expect(sparOutcome([START, WHITE_MATED], 'white')).toEqual({
      result: 'loss',
      reason: 'checkmate',
    })
    expect(sparOutcome([START, WHITE_MATED], 'black')).toEqual({
      result: 'win',
      reason: 'checkmate',
    })
  })

  it('draws a stalemate and bare kings', () => {
    expect(sparOutcome(['7k/5Q2/6K1/8/8/8/8/8 b - -'], 'white')?.reason).toBe('stalemate')
    expect(sparOutcome(['8/8/4k3/8/8/4K3/8/8 w - -'], 'black')).toEqual({
      result: 'draw',
      reason: 'insufficient material',
    })
  })

  it('draws the third time a position repeats in the line, not before', () => {
    const a = 'r1bqkbnr/pppppppp/2n5/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq -'
    const b = 'r1bqkbnr/pppppppp/2n5/8/8/8/PPPPPPPP/RNBQKBNR b KQkq -'
    expect(sparOutcome([a, b, a], 'white')).toBeNull()
    expect(sparOutcome([a, b, a, b, a], 'white')).toEqual({ result: 'draw', reason: 'repetition' })
  })

  it('is still in play at the start', () => {
    expect(sparOutcome([START], 'white')).toBeNull()
    expect(sparOutcome([], 'white')).toBeNull()
  })
})

describe('opponent strength', () => {
  it('starts at the player’s slowest rated time control', () => {
    expect(startingSparElo({ rapid: 1669, blitz: 1422 })).toBe(1669)
    expect(startingSparElo({ blitz: 1422 })).toBe(1422)
    expect(startingSparElo({ rapid: 150 })).toBe(400)
    expect(startingSparElo(null)).toBe(1200)
  })

  it('walks toward an even match', () => {
    expect(nextSparElo(1650, 'win')).toBe(1690)
    expect(nextSparElo(1650, 'loss')).toBe(1610)
    expect(nextSparElo(1650, 'draw')).toBe(1650)
    expect(nextSparElo(420, 'loss')).toBe(400)
  })
})

describe('moves', () => {
  it('turns an engine move into what the board records', () => {
    expect(applyUciMove(START, 'e2e4')).toEqual({
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -',
      san: 'e4',
      uci: 'e2e4',
    })
    expect(applyUciMove('8/P6k/8/8/8/8/8/K7 w - -', 'a7a8n')?.san).toBe('a8=N')
    expect(applyUciMove(START, 'e2e5')).toBeNull()
  })

  it('reads the side to move and varies the reply time', () => {
    expect(sideToMove(START)).toBe('white')
    expect(sideToMove(WHITE_MATED.replace(' w ', ' b '))).toBe('black')
    expect(sparMoveTimeMs(() => 0)).toBe(500)
    expect(sparMoveTimeMs(() => 1)).toBe(1400)
  })

  it('describes each ending in words', () => {
    expect(describeOutcome({ result: 'win', reason: 'checkmate' })).toBe('You won by checkmate.')
    expect(describeOutcome({ result: 'loss', reason: 'resignation' })).toBe('You resigned.')
    expect(describeOutcome({ result: 'draw', reason: 'repetition' })).toBe('Draw by repetition.')
  })
})

describe('how the opponent chooses', () => {
  const line = (multipv: number, uci: string, score: { type: 'cp' | 'mate'; value: number }) => ({
    depth: 4,
    seldepth: null,
    multipv,
    score,
    nodes: null,
    nps: null,
    time: null,
    pv: [uci],
  })
  const lines = [
    line(1, 'e2e4', { type: 'cp', value: 40 }),
    line(2, 'd2d4', { type: 'cp', value: 30 }),
    line(3, 'g1h3', { type: 'cp', value: -160 }),
  ]

  it('picks by how much worse each candidate looks', () => {
    // Weights at T=40: 1, e^-0.25 ≈ 0.78, e^-5 ≈ 0.007.
    expect(chooseSparMove(lines, 40, () => 0)).toBe('e2e4')
    expect(chooseSparMove(lines, 40, () => 0.7)).toBe('d2d4')
    expect(chooseSparMove(lines, 40, () => 0.9999)).toBe('g1h3')
    // A mate outweighs any centipawn score.
    expect(
      chooseSparMove([...lines, line(4, 'd1h5', { type: 'mate', value: 2 })], 10, () => 0.5),
    ).toBe('d1h5')
    expect(chooseSparMove([], 40)).toBeNull()
  })

  it('plays the calibrated model at the player’s rating', () => {
    expect(sparSearchParams(CALIBRATION_RATING)).toEqual({ depth: 2, multiPV: 8, temperature: 110 })
  })

  it('sees further and chooses more carefully as the strength rises', () => {
    const base = sparSearchParams(CALIBRATION_RATING)
    const stronger = sparSearchParams(CALIBRATION_RATING + 300)
    const weaker = sparSearchParams(CALIBRATION_RATING - 300)
    expect(stronger.depth).toBeGreaterThan(base.depth)
    expect(stronger.temperature).toBeCloseTo(base.temperature / 2)
    expect(weaker.temperature).toBeCloseTo(base.temperature * 2)
    // Weaker only ever means more random, never a one-ply horizon.
    expect(weaker.depth).toBe(2)
    expect(sparSearchParams(400).depth).toBe(2)
    expect(sparSearchParams(2800).depth).toBeLessThanOrEqual(12)
  })
})

describe('opening book', () => {
  const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
  const master = [
    { uci: 'c7c5', game_count: 600 },
    { uci: 'e7e5', game_count: 300 },
    { uci: 'e7e6', game_count: 90 },
    { uci: 'a7a6', game_count: 10 }, // 1% of games: a sideline, never chosen
    { uci: 'e2e4', game_count: 500 }, // not legal here: never chosen
  ]

  it('plays book moves in proportion to how often masters do', () => {
    expect(chooseBookMove(AFTER_E4, master, () => 0)).toBe('c7c5')
    expect(chooseBookMove(AFTER_E4, master, () => 0.7)).toBe('e7e5')
    expect(chooseBookMove(AFTER_E4, master, () => 0.99)).toBe('e7e6')
  })

  it('leaves the move to the engine out of book', () => {
    expect(chooseBookMove(AFTER_E4, [], () => 0)).toBeNull()
    expect(chooseBookMove(AFTER_E4, [{ uci: 'a7a6', game_count: 5 }], () => 0)).toBeNull()
  })
})
