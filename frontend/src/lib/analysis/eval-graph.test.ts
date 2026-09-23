import { describe, expect, it } from 'vite-plus/test'

import {
  buildAreaPath,
  buildLinePath,
  clampCp,
  EVAL_CLAMP_CP,
  layoutEvalPoints,
  xForIndex,
} from './eval-graph'

describe('clampCp', () => {
  it('leaves ordinary evaluations alone', () => {
    expect(clampCp(120)).toBe(120)
  })

  it('caps a winning position at the limit in both directions', () => {
    expect(clampCp(5000)).toBe(EVAL_CLAMP_CP)
    expect(clampCp(-5000)).toBe(-EVAL_CLAMP_CP)
  })

  it('treats a non-number as equal', () => {
    expect(clampCp(Number.NaN)).toBe(0)
  })
})

describe('layoutEvalPoints', () => {
  const box = { width: 100, height: 50 }

  it('puts a dead-equal position on the midline', () => {
    const [point] = layoutEvalPoints({ evaluations: [0], ...box })
    expect(point.y).toBe(25)
  })

  it('puts White winning at the top and Black winning at the bottom', () => {
    const points = layoutEvalPoints({ evaluations: [EVAL_CLAMP_CP, -EVAL_CLAMP_CP], ...box })
    expect(points[0].y).toBe(0)
    expect(points[1].y).toBe(50)
  })

  it('spreads positions evenly across the width', () => {
    const points = layoutEvalPoints({ evaluations: [0, 0, 0], ...box })
    expect(points.map((p) => p.x)).toEqual([0, 50, 100])
  })

  it('skips positions with no evaluation instead of inventing one', () => {
    const points = layoutEvalPoints({ evaluations: [0, null, 100], ...box })
    expect(points.map((p) => p.index)).toEqual([0, 2])
  })

  it('keeps the x of later points anchored to their real ply', () => {
    const points = layoutEvalPoints({ evaluations: [0, null, 100], ...box })
    expect(points[1].x).toBe(100)
  })

  it('does not divide by zero on a single position', () => {
    expect(layoutEvalPoints({ evaluations: [50], ...box })[0].x).toBe(0)
  })

  it('returns nothing when nothing is analyzed', () => {
    expect(layoutEvalPoints({ evaluations: [null, null], ...box })).toEqual([])
  })
})

describe('buildLinePath', () => {
  it('moves to the first point and lines to the rest', () => {
    const points = layoutEvalPoints({ evaluations: [0, 0], width: 10, height: 10 })
    expect(buildLinePath(points)).toBe('M0.00 5.00 L10.00 5.00')
  })

  it('is empty with no points', () => {
    expect(buildLinePath([])).toBe('')
  })
})

describe('buildAreaPath', () => {
  it('closes the shape against the given edge', () => {
    const points = layoutEvalPoints({ evaluations: [0, 0], width: 10, height: 10 })
    const path = buildAreaPath(points, 10)
    expect(path.startsWith('M0.00 10')).toBe(true)
    expect(path.endsWith('Z')).toBe(true)
  })

  it('is empty with no points', () => {
    expect(buildAreaPath([], 10)).toBe('')
  })
})

describe('xForIndex', () => {
  it('maps the last position to the far edge', () => {
    expect(xForIndex(4, 5, 100)).toBe(100)
  })

  it('clamps an out-of-range index rather than overflowing', () => {
    expect(xForIndex(99, 5, 100)).toBe(100)
    expect(xForIndex(-3, 5, 100)).toBe(0)
  })
})
