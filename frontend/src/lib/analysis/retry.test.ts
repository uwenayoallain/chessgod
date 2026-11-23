import { describe, expect, it } from 'vite-plus/test'

import type { ReplayMoveAnnotation } from './replay-annotations'
import { judgeRetry, retryItems, scoreToCp } from './retry'

function move(ply: number, extra: Partial<ReplayMoveAnnotation> = {}): ReplayMoveAnnotation {
  return {
    ply,
    san: `m${ply}`,
    uci: `u${ply}`,
    fen: `fen${ply} ${ply % 2 ? 'b' : 'w'} - - 0 1`,
    bestMove: `b${ply}`,
    cpLoss: 0,
    label: 'Best',
    ...extra,
  }
}

describe('retry', () => {
  it('takes the worst mistakes and asks them in game order', () => {
    const annotations = [
      move(1),
      move(2),
      move(3, { label: 'Blunder', cpLoss: 400 }),
      move(4),
      move(5, { label: 'Inaccuracy', cpLoss: 60 }),
      move(6, { label: 'Blunder', cpLoss: 500 }),
      move(7, { label: 'Mistake', cpLoss: 150 }),
    ]
    const fens = ['start', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']
    const nodes = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']
    const items = retryItems(annotations, fens, nodes, 'white')
    // White moves on odd plies: the black blunder at ply 6 and the inaccuracy stay out.
    expect(items.map((item) => item.ply)).toEqual([3, 7])
    expect(items[0]).toMatchObject({
      fenBefore: 'f2',
      parentNodeId: 'n2',
      lastUci: 'u2',
      bestUci: 'b3',
    })
  })

  it('judges an attempt against the engine, not only its first choice', () => {
    const base = { gameUci: 'e2e4', bestUci: 'd2d4' }
    expect(judgeRetry({ ...base, attemptUci: 'e2e4' })).toBe('same')
    expect(judgeRetry({ ...base, attemptUci: 'd2d4' })).toBe('best')
    expect(judgeRetry({ ...base, attemptUci: 'c2c4', bestCp: 40, attemptCp: 20 })).toBe('good')
    expect(judgeRetry({ ...base, attemptUci: 'c2c4', bestCp: 40, attemptCp: -200 })).toBe('worse')
    expect(judgeRetry({ ...base, attemptUci: 'c2c4' })).toBe('worse')
    expect(scoreToCp({ type: 'mate', value: 3 })).toBe(1970)
    expect(scoreToCp({ type: 'cp', value: 9000 })).toBe(1500)
  })
})
