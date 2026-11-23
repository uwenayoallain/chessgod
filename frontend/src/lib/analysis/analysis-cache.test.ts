import { describe, expect, it } from 'vite-plus/test'

import {
  mergeEngineAnalysis,
  needsEngineAnalysis,
  retainDeeperAnalysis,
  reviewLineOf,
} from './analysis-cache'

describe('needsEngineAnalysis', () => {
  it('keeps a deeper snapshot intact when an interrupted search finishes shallow', () => {
    const deep = { depth: 30, score: 24, pv: ['e2e4'] }
    const partial = { depth: 12, score: -90, pv: ['d2d4'] }
    expect(retainDeeperAnalysis(deep, partial)).toBe(deep)
    expect(retainDeeperAnalysis(partial, deep)).toBe(deep)
    expect(retainDeeperAnalysis(undefined, partial)).toBe(partial)
  })
  it('requires analysis when there is no cached depth', () => {
    expect(needsEngineAnalysis(null, 12, false)).toBe(true)
  })

  it('reuses cached analysis when it already meets the requested depth', () => {
    expect(needsEngineAnalysis(18, 12, false)).toBe(false)
  })

  it('requests a deeper analysis when the cached depth is lower', () => {
    expect(needsEngineAnalysis(12, 18, false)).toBe(true)
  })

  it('forces analysis when explicitly requested', () => {
    expect(needsEngineAnalysis(18, 18, true)).toBe(true)
  })

  it('does not treat a single principal variation as a complete multi-line search', () => {
    expect(needsEngineAnalysis(30, 30, false, 1, 3)).toBe(true)
    expect(needsEngineAnalysis(30, 30, false, 3, 2)).toBe(false)
  })

  it('merges MultiPV alternatives into a deeper primary snapshot', () => {
    const deep = {
      depth: 30,
      bestMove: 'e2e4',
      lines: [{ depth: 30, multipv: 1, pv: ['e2e4'] }],
    }
    const alternatives = {
      depth: 24,
      bestMove: 'd2d4',
      lines: [
        { depth: 24, multipv: 1, pv: ['d2d4'] },
        { depth: 24, multipv: 2, pv: ['c2c4'] },
      ],
    }

    const merged = mergeEngineAnalysis(deep, alternatives)
    expect(merged.depth).toBe(30)
    expect(merged.bestMove).toBe('e2e4')
    expect(merged.lines).toEqual([
      { depth: 30, multipv: 1, pv: ['e2e4'] },
      { depth: 24, multipv: 2, pv: ['c2c4'] },
    ])
  })

  it('requires every requested variation to reach the requested depth', () => {
    expect(needsEngineAnalysis(30, 30, false, 1, 2)).toBe(true)
  })

  it('does not count an old alternative again when it becomes the best move', () => {
    const merged = mergeEngineAnalysis(
      {
        depth: 24,
        bestMove: 'e2e4',
        lines: [
          { depth: 24, multipv: 1, pv: ['e2e4'] },
          { depth: 24, multipv: 2, pv: ['d2d4'] },
        ],
      },
      {
        depth: 30,
        bestMove: 'd2d4',
        lines: [{ depth: 30, multipv: 1, pv: ['d2d4'] }],
      },
    )
    expect(merged.lines).toEqual([{ depth: 30, multipv: 1, pv: ['d2d4'] }])
    expect(needsEngineAnalysis(merged.depth, 24, false, merged.lines.length, 2)).toBe(true)
  })

  it('keeps the existing snapshot identity when a partial search adds no evidence', () => {
    const deep = {
      depth: 30,
      bestMove: 'e2e4',
      persisted: true,
      lines: [{ depth: 30, multipv: 1, pv: ['e2e4'] }],
    }
    expect(
      mergeEngineAnalysis(deep, {
        depth: 12,
        bestMove: 'd2d4',
        persisted: false,
        lines: [{ depth: 12, multipv: 1, pv: ['d2d4'] }],
      }),
    ).toBe(deep)
  })
})

describe('reviewLineOf', () => {
  const review = { depth: 20, multipv: 1, pv: ['e2e4'] }
  const board = { depth: 28, multipv: 1, pv: ['d2d4'] }

  it('keeps the review-depth line when a deeper look at the board replaces it', () => {
    // The board's depth-28 search is what the board shows; the game review
    // still grades the move from the depth-20 search its partner shares.
    const merged = mergeEngineAnalysis(
      { depth: 20, bestMove: 'e2e4', lines: [review] },
      { depth: 28, bestMove: 'd2d4', lines: [board] },
    )
    expect(merged.lines).toEqual([board])
    expect((merged as { reviewLine?: unknown }).reviewLine).toBe(review)
    expect(reviewLineOf(merged)).toBe(review)

    // A later, deeper board search keeps it too.
    const deeper = mergeEngineAnalysis(merged, {
      depth: 30,
      bestMove: 'd2d4',
      lines: [{ depth: 30, multipv: 1, pv: ['d2d4'] }],
    })
    expect(reviewLineOf(deeper)).toBe(review)
  })

  it('is absent for a position only ever searched outside the review band', () => {
    expect(reviewLineOf({ lines: [board] })).toBeNull()
    expect(reviewLineOf({ lines: [{ depth: 14, multipv: 1, pv: ['e2e4'] }] })).toBeNull()
    expect(reviewLineOf({ lines: [{ depth: 20, multipv: 2, pv: ['e2e4'] }] })).toBeNull()
  })

  it('prefers the line closest to the review depth, then the deeper', () => {
    const at22 = { depth: 22, multipv: 1, pv: ['c2c4'] }
    const at19 = { depth: 19, multipv: 1, pv: ['g1f3'] }
    const at21 = { depth: 21, multipv: 1, pv: ['b1c3'] }
    const from22 = mergeEngineAnalysis(
      { depth: 22, bestMove: 'c2c4', lines: [at22] },
      { depth: 28, bestMove: 'd2d4', lines: [board] },
    )
    expect(
      reviewLineOf(mergeEngineAnalysis(from22, { depth: 19, bestMove: 'g1f3', lines: [at19] })),
    ).toBe(at19)
    expect(
      reviewLineOf(
        mergeEngineAnalysis(
          mergeEngineAnalysis(from22, { depth: 19, bestMove: 'g1f3', lines: [at19] }),
          { depth: 21, bestMove: 'b1c3', lines: [at21] },
        ),
      ),
    ).toBe(at21)
  })

  type Line = { depth: number; multipv: number; pv: string[] }
  type Snapshot = {
    depth: number
    bestMove: string | null
    lines: Line[]
    reviewLine?: Line
    persisted?: boolean
    reviewLinePersisted?: boolean
  }

  it('does not call a fresh review line stored because the deeper search beside it is', () => {
    // The board's depth-28 search came from the database. The review search
    // that lands beside it has not been uploaded, and `persisted` alone would
    // tell the upload hook there is nothing to send.
    const merged = mergeEngineAnalysis<Snapshot>(
      { depth: 28, bestMove: 'd2d4', persisted: true, lines: [board] },
      { depth: 20, bestMove: 'e2e4', persisted: false, lines: [review] },
    )
    expect(merged.lines).toEqual([board])
    expect(merged.persisted).toBe(true)
    expect(merged.reviewLine).toBe(review)
    expect(merged.reviewLinePersisted).toBe(false)

    // A later stored board search does not launder it into a stored line.
    const deeper = mergeEngineAnalysis<Snapshot>(merged, {
      depth: 30,
      bestMove: 'd2d4',
      persisted: true,
      lines: [{ depth: 30, multipv: 1, pv: ['d2d4'] }],
    })
    expect(deeper.persisted).toBe(true)
    expect(deeper.reviewLine).toBe(review)
    expect(deeper.reviewLinePersisted).toBe(false)
  })

  it('keeps a review line stored when it came from the database', () => {
    // The other way round: a fresh deeper look beside a stored review row.
    const hydrated = mergeEngineAnalysis<Snapshot>(
      { depth: 28, bestMove: 'd2d4', persisted: false, lines: [board] },
      { depth: 20, bestMove: 'e2e4', persisted: true, lines: [review] },
    )
    expect(hydrated.persisted).toBe(false)
    expect(hydrated.reviewLinePersisted).toBe(true)

    const displaced = mergeEngineAnalysis<Snapshot>(
      { depth: 20, bestMove: 'e2e4', persisted: true, lines: [review] },
      { depth: 28, bestMove: 'd2d4', persisted: false, lines: [board] },
    )
    expect(displaced.persisted).toBe(false)
    expect(displaced.reviewLine).toBe(review)
    expect(displaced.reviewLinePersisted).toBe(true)
  })

  it('carries no separate review line while the line is still in `lines`', () => {
    const merged = mergeEngineAnalysis(
      { depth: 20, bestMove: 'e2e4', lines: [review] },
      { depth: 20, bestMove: 'e2e4', lines: [review, { depth: 20, multipv: 2, pv: ['d2d4'] }] },
    )
    expect(merged).not.toHaveProperty('reviewLine')
    expect(merged).not.toHaveProperty('reviewLinePersisted')
    expect(reviewLineOf(merged)).toBe(review)
  })
})
