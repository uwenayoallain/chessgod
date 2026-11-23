import { describe, expect, it } from 'vite-plus/test'

import type { ReplayMoveAnnotation } from '@/lib/analysis/replay-annotations'
import type { UCIInfo } from '@/lib/stockfish/uci'

import { collectSparringMistakes } from './sparring-mistakes'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
const AFTER_F3 = 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq -'
const AFTER_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq -'
const AFTER_G4 = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq -'

function top(pv: string[], score: UCIInfo['score'], depth = 18): { lines: UCIInfo[] } {
  return {
    lines: [{ depth, seldepth: null, multipv: 1, score, nodes: null, nps: null, time: null, pv }],
  }
}

function move(
  ply: number,
  san: string,
  uci: string,
  fen: string,
  label: ReplayMoveAnnotation['label'],
  cpLoss: number | null,
): ReplayMoveAnnotation {
  return { ply, san, uci, fen, bestMove: null, cpLoss, label }
}

const fenHistory = [START, AFTER_F3, AFTER_E5, AFTER_G4]
const annotations = [
  move(1, 'f3', 'f2f3', AFTER_F3, 'Inaccuracy', 60),
  move(2, 'e5', 'e7e5', AFTER_E5, 'Best', 0),
  move(3, 'g4', 'g2g4', AFTER_G4, 'Blunder', 9_000),
]
const analysisByFen = {
  [AFTER_E5]: top(['d2d4', 'e5d4'], { type: 'cp', value: -40 }),
  [AFTER_G4]: top(['d8h4'], { type: 'mate', value: 1 }),
}

describe('collectSparringMistakes', () => {
  it('keeps the player’s mistakes, with the line that refutes them', () => {
    const mistakes = collectSparringMistakes({
      annotations,
      analysisByFen,
      fenHistory,
      userColor: 'white',
    })
    expect(mistakes).toEqual([
      {
        fen: AFTER_E5,
        ply: 3,
        user_move_uci: 'g2g4',
        user_move_san: 'g4',
        best_move_uci: 'd2d4',
        best_pv_uci: 'd2d4 e5d4',
        reply_pv_uci: 'd8h4',
        previous_move_uci: 'e7e5',
        parent_eval_cp: -40,
        parent_eval_mate: null,
        eval_drop_cp: 4000,
        depth: 18,
      },
    ])
  })

  it('never drills the engine’s moves, or a move the review has no deep line for', () => {
    expect(
      collectSparringMistakes({ annotations, analysisByFen, fenHistory, userColor: 'black' }),
    ).toEqual([])
    const shallow = { ...analysisByFen, [AFTER_E5]: top(['d2d4'], { type: 'cp', value: -40 }, 12) }
    expect(
      collectSparringMistakes({
        annotations,
        analysisByFen: shallow,
        fenHistory,
        userColor: 'white',
      }),
    ).toEqual([])
  })
})
