import { describe, expect, it } from 'vite-plus/test'

import { selectCurrentEngineView } from './engine-view'
import type { UCIInfo } from './stockfish/uci'

function line(value: number, pv = ['e2e4']): UCIInfo {
  return {
    depth: 12,
    multipv: 1,
    nodes: null,
    nps: null,
    pv,
    score: { type: 'cp', value },
    seldepth: null,
    time: null,
  }
}

describe('selectCurrentEngineView', () => {
  it('does not expose live engine lines when they belong to a different FEN', () => {
    const view = selectCurrentEngineView({
      analysisByFen: {},
      analyzedFen: 'old-fen',
      bestMove: 'e2e4',
      currentDepth: 12,
      currentFen: 'new-fen',
      lines: [line(-300)],
    })

    expect(view.lines).toEqual([])
    expect(view.bestMove).toBeNull()
    expect(view.currentDepth).toBe(0)
  })

  it('uses cached analysis for the visible FEN while a different FEN is live', () => {
    const cached = {
      bestMove: 'g1f3',
      depth: 18,
      lines: [line(250, ['g1f3'])],
    }

    const view = selectCurrentEngineView({
      analysisByFen: { 'new-fen': cached },
      analyzedFen: 'old-fen',
      bestMove: 'e2e4',
      currentDepth: 12,
      currentFen: 'new-fen',
      lines: [line(-300)],
    })

    expect(view.lines).toBe(cached.lines)
    expect(view.bestMove).toBe('g1f3')
    expect(view.currentDepth).toBe(18)
  })
})
