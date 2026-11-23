import { describe, expect, it } from 'vite-plus/test'

import { mergeEngineAnalysis, needsEngineAnalysis, retainDeeperAnalysis } from './analysis-cache'

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
