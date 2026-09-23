import { describe, expect, it } from 'vite-plus/test'

import { formatCost, REVIEW_LABELS, reviewCoverage, reviewSide, sideOfPly } from './game-review'
import type { ReplayMoveAnnotation } from './replay-annotations'

function move(
  ply: number,
  label: ReplayMoveAnnotation['label'],
  cpLoss: number | null,
): ReplayMoveAnnotation {
  return { ply, san: `m${ply}`, uci: 'a1a2', fen: `fen-${ply}`, bestMove: 'a1a2', cpLoss, label }
}

describe('sideOfPly', () => {
  it('gives odd plies to White', () => {
    expect(sideOfPly(1)).toBe('white')
    expect(sideOfPly(2)).toBe('black')
    expect(sideOfPly(7)).toBe('white')
  })
})

describe('reviewSide', () => {
  const line = [
    move(1, 'Book', 0),
    move(2, 'Book', 0),
    move(3, 'Best', 0),
    move(4, 'Blunder', 400),
    move(5, 'Inaccuracy', 60),
    move(6, 'Mistake', 150),
  ]

  it('counts only the side asked for', () => {
    const white = reviewSide(line, 'white')
    expect(white.moves).toBe(3)
    expect(white.counts.Best).toBe(1)
    expect(white.counts.Blunder).toBe(0)

    const black = reviewSide(line, 'black')
    expect(black.moves).toBe(3)
    expect(black.counts.Blunder).toBe(1)
    expect(black.counts.Mistake).toBe(1)
  })

  it('averages centipawn loss over judged moves only', () => {
    const white = reviewSide(
      [move(1, 'Best', 0), move(3, 'Mistake', 100), move(5, null, null)],
      'white',
    )
    expect(white.judged).toBe(2)
    expect(white.moves).toBe(3)
    expect(white.averageLossCp).toBe(50)
  })

  it('has no average before anything is judged', () => {
    expect(reviewSide([move(1, null, null)], 'white').averageLossCp).toBeNull()
  })

  it('ranks the costly moves by what they cost', () => {
    const black = reviewSide(line, 'black')
    expect(black.costly.map((m) => m.ply)).toEqual([4, 6])
    expect(black.costly[0].cpLoss).toBe(400)
  })

  it('leaves book and best moves out of the costly list', () => {
    const white = reviewSide(line, 'white')
    // White played Book, Best and one Inaccuracy — only the inaccuracy is costly.
    expect(white.costly.map((m) => m.ply)).toEqual([5])
  })
})

describe('reviewCoverage', () => {
  it('reports how much of the line has been judged', () => {
    expect(reviewCoverage([move(1, 'Best', 0), move(2, null, null)])).toEqual({
      judged: 1,
      total: 2,
      complete: false,
    })
  })

  it('is complete when every move has an evaluation', () => {
    expect(reviewCoverage([move(1, 'Best', 0)]).complete).toBe(true)
  })

  it('is complete for an empty line rather than dividing by zero', () => {
    expect(reviewCoverage([])).toEqual({ judged: 0, total: 0, complete: true })
  })
})

describe('REVIEW_LABELS', () => {
  it('runs best to worst so the chips read in one direction', () => {
    expect(REVIEW_LABELS[0]).toBe('Brilliant')
    expect(REVIEW_LABELS.at(-1)).toBe('Blunder')
  })
})

describe('formatCost', () => {
  it('shows an ordinary loss as centipawns', () => {
    expect(formatCost(739)).toBe('\u2212739')
  })

  it('caps a runaway figure instead of printing nonsense', () => {
    // The engine can report enormous scores near mate; "-8163" means nothing.
    expect(formatCost(8163)).toBe('\u2212999+')
  })

  it('rounds rather than showing decimals', () => {
    expect(formatCost(12.6)).toBe('\u221213')
  })

  it('never shows a negative cost', () => {
    expect(formatCost(-5)).toBe('\u22120')
  })

  it('shows nothing when the move has not been judged', () => {
    expect(formatCost(null)).toBe('')
    expect(formatCost(Number.NaN)).toBe('')
  })
})
