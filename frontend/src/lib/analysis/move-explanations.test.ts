import { describe, expect, it } from 'vite-plus/test'

import type { UCIInfo } from '@/lib/stockfish/uci'

import { explanationRequests } from './move-explanations'

const AFTER_B6 = 'rnbqkbnr/p2ppppp/1p6/2p4Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq -'
const AFTER_QXF7 = 'rnbqkbnr/p2ppQpp/1p6/2p5/4P3/8/PPPP1PPP/RNB1KBNR b KQkq -'

function lines(pv: string[], score: UCIInfo['score']) {
  return {
    lines: [
      { depth: 18, seldepth: null, multipv: 1, score, nodes: null, nps: null, time: null, pv },
    ],
  }
}

const blunder = {
  ply: 5,
  san: 'Qxf7+',
  uci: 'h5f7',
  fen: AFTER_QXF7,
  bestMove: 'g1f3',
  cpLoss: 887,
  label: 'Blunder' as const,
}

describe('explanationRequests', () => {
  it('sends the lines either side of the move', () => {
    const requests = explanationRequests({
      moves: [blunder],
      analysisByFen: {
        [AFTER_B6]: lines(['g1f3', 'g8f6'], { type: 'cp', value: 80 }),
        [AFTER_QXF7]: lines(['e8f7'], { type: 'cp', value: 810 }),
      },
      fenHistory: ['start', 'a', 'b', 'c', AFTER_B6, AFTER_QXF7],
    })
    expect(requests).toEqual([
      {
        fen: AFTER_B6,
        ply: 5,
        user_move_uci: 'h5f7',
        best_move_uci: 'g1f3',
        best_pv_uci: 'g1f3 g8f6',
        reply_pv_uci: 'e8f7',
        parent_eval_cp: 80,
        best_eval_mate: null,
        eval_drop_cp: 887,
      },
    ])
  })

  it('waits for the position before the move to be searched', () => {
    expect(
      explanationRequests({
        moves: [blunder],
        analysisByFen: {},
        fenHistory: ['start', 'a', 'b', 'c', AFTER_B6],
      }),
    ).toEqual([])
  })
})
