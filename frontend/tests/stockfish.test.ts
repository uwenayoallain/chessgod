import { describe, expect, test } from 'vitest'

import { parseUCIInfoLine } from '../src/lib/stockfish/uci'

describe('parseUCIInfoLine', () => {
  test('parses centipawn info lines', () => {
    const line =
      'info depth 18 seldepth 24 multipv 2 score cp 35 nodes 100000 nps 50000 pv e2e4 e7e5 g1f3'

    expect(parseUCIInfoLine(line)).toEqual({
      depth: 18,
      seldepth: 24,
      multipv: 2,
      score: { type: 'cp', value: 35 },
      nodes: 100000,
      nps: 50000,
      time: null,
      pv: ['e2e4', 'e7e5', 'g1f3'],
    })
  })

  test('parses mate info lines', () => {
    const line = 'info depth 20 multipv 1 score mate 3 nodes 20000 nps 40000 pv g7g8q'

    expect(parseUCIInfoLine(line)).toEqual({
      depth: 20,
      seldepth: null,
      multipv: 1,
      score: { type: 'mate', value: 3 },
      nodes: 20000,
      nps: 40000,
      time: null,
      pv: ['g7g8q'],
    })
  })
})
