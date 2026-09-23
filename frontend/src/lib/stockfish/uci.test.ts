import { describe, expect, it } from 'vite-plus/test'

import { parseUCIInfoLine } from './uci'

describe('parseUCIInfoLine', () => {
  it('parses centipawn multiPV lines', () => {
    expect(
      parseUCIInfoLine(
        'info depth 18 seldepth 24 multipv 2 score cp 34 nodes 1000 nps 100000 pv e2e4 e7e5 g1f3',
      ),
    ).toEqual({
      depth: 18,
      seldepth: 24,
      multipv: 2,
      score: { type: 'cp', value: 34 },
      nodes: 1000,
      nps: 100000,
      time: null,
      pv: ['e2e4', 'e7e5', 'g1f3'],
    })
  })

  it('parses mate lines and defaults multipv to one', () => {
    expect(parseUCIInfoLine('info depth 20 score mate -3 nodes 1000 nps 100000 pv h7h1q')).toEqual({
      depth: 20,
      seldepth: null,
      multipv: 1,
      score: { type: 'mate', value: -3 },
      nodes: 1000,
      nps: 100000,
      time: null,
      pv: ['h7h1q'],
    })
  })

  it('returns null when the line has no pv payload', () => {
    expect(parseUCIInfoLine('info depth 10 score cp 14 nodes 1000')).toBeNull()
  })

  it('does not present aspiration bounds or missing scores as exact evaluations', () => {
    for (const score of [
      'score cp 300 lowerbound',
      'score cp -200 upperbound',
      'score mate 4 lowerbound',
      '',
    ]) {
      expect(parseUCIInfoLine(`info depth 22 ${score} nodes 1000 pv e2e4`)).toBeNull()
    }
  })
})
