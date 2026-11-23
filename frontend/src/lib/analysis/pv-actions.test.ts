import { describe, expect, it } from 'vite-plus/test'

import { getPvPrefixToMove } from './pv-actions'

describe('getPvPrefixToMove', () => {
  const moves = [
    { fen: 'after-e4', san: 'e4', uci: 'e2e4' },
    { fen: 'after-e5', san: 'e5', uci: 'e7e5' },
    { fen: 'after-nf3', san: 'Nf3', uci: 'g1f3' },
  ]

  it('returns every prior PV move needed to reach the clicked move', () => {
    expect(getPvPrefixToMove(moves, 1)).toEqual([
      { fen: 'after-e4', san: 'e4', uci: 'e2e4' },
      { fen: 'after-e5', san: 'e5', uci: 'e7e5' },
    ])
  })

  it('returns an empty prefix for an out-of-range move', () => {
    expect(getPvPrefixToMove(moves, -1)).toEqual([])
    expect(getPvPrefixToMove(moves, 3)).toEqual([])
  })
})
