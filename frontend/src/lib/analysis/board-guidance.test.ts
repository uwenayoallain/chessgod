import { describe, expect, it } from 'vitest'

import { buildGuidanceArrows, buildLatestMoveSquareStyles, getLatestMoveSquares } from './board-guidance'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

describe('buildGuidanceArrows', () => {
  it('shows the current side best move when engine analysis is available', () => {
    expect(buildGuidanceArrows({ bestMove: 'g1f3', fen: START_FEN })).toContainEqual({
      color: 'rgba(20, 184, 166, 0.72)',
      endSquare: 'f3',
      startSquare: 'g1',
    })
  })

  it('does not show stale best moves that are illegal in the current position', () => {
    expect(buildGuidanceArrows({ bestMove: 'e2e4', fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1' })).not.toContainEqual({
      color: 'rgba(20, 184, 166, 0.72)',
      endSquare: 'e4',
      startSquare: 'e2',
    })
  })

  it('shows a threat when the opponent can capture an undefended piece', () => {
    expect(buildGuidanceArrows({ bestMove: null, fen: '4r3/8/8/8/4Q3/8/8/4K2k w - - 0 1' })).toContainEqual({
      color: 'rgba(239, 68, 68, 0.72)',
      endSquare: 'e4',
      startSquare: 'e8',
    })
  })

  it('does not show threat arrows for the player who is currently to move', () => {
    expect(buildGuidanceArrows({ bestMove: null, fen: '4r3/8/8/8/4Q3/8/8/4K2k b - - 0 1' })).not.toContainEqual({
      color: 'rgba(239, 68, 68, 0.72)',
      endSquare: 'e4',
      startSquare: 'e8',
    })
  })
})

describe('getLatestMoveSquares', () => {
  it('returns the origin and destination squares for a UCI move', () => {
    expect(getLatestMoveSquares('e2e4')).toEqual(['e2', 'e4'])
  })

  it('ignores missing or malformed UCI moves', () => {
    expect(getLatestMoveSquares(null)).toBeNull()
    expect(getLatestMoveSquares('e2')).toBeNull()
  })
})

describe('buildLatestMoveSquareStyles', () => {
  it('styles both the origin and destination squares', () => {
    const styles = buildLatestMoveSquareStyles('e2e4')

    expect(styles.e2).toMatchObject({
      backgroundColor: 'rgba(250, 204, 21, 0.3)',
      boxShadow: expect.stringContaining('inset'),
    })
    expect(styles.e4).toMatchObject({
      backgroundColor: 'rgba(250, 204, 21, 0.2)',
    })
  })
})
