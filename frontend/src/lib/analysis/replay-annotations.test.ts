import { describe, expect, it } from 'vite-plus/test'

import { buildReplayMoveAnnotations } from './replay-annotations'
import type { UCIInfo } from '@/lib/stockfish/uci'
import { Chess } from 'chess.js'

function line({
  depth = 18,
  multipv = 1,
  pv,
  value,
}: {
  depth?: number
  multipv?: number
  pv: string[]
  value: number
}): UCIInfo {
  return {
    depth,
    multipv,
    nodes: null,
    nps: null,
    pv,
    score: { type: 'cp', value },
    seldepth: null,
    time: null,
  }
}

describe('buildReplayMoveAnnotations', () => {
  it.each([
    ['8/8/8/8/4q3/5k2/8/7K w - -', 'h1h2', 'h1g1'],
    ['7k/8/5K2/4Q3/8/8/8/8 b - -', 'h8h7', 'h8g8'],
  ])('does not create another mistake from an already forced loss: %s', (parent, best, played) => {
    const board = new Chess(parent)
    const move = board.move({ from: played.slice(0, 2), to: played.slice(2, 4) })
    const child = board.fen()
    for (const childScore of [
      { type: 'cp', value: 3000 },
      { type: 'mate', value: 1 },
    ] as const) {
      const annotations = buildReplayMoveAnnotations({
        analysisByFen: {
          [parent]: {
            bestMove: best,
            depth: 22,
            lines: [{ ...line({ pv: [best], value: 0 }), score: { type: 'mate', value: -20 } }],
          },
          [child]: {
            bestMove: 'reply',
            depth: 22,
            lines: [{ ...line({ pv: ['reply'], value: 0 }), score: childScore }],
          },
        },
        bookPlies: new Set(),
        fenHistory: [parent, child],
        replayMoves: [{ ply: 1, san: move.san, uci: played, fen: child }],
      })
      expect(annotations[0].cpLoss).toBe(0)
    }
  })

  it.each([
    ['6k1/4Q3/6K1/8/8/8/8/8 w - -', 'e7e8', 'e7f7'],
    ['8/8/8/8/8/6k1/4q3/6K1 b - -', 'e2e1', 'e2f2'],
  ])('does not penalize a preserved forced win from %s', (parent, best, played) => {
    const board = new Chess(parent)
    const move = board.move({ from: played.slice(0, 2), to: played.slice(2, 4) })
    const child = board.fen()
    for (const parentScore of [
      { type: 'cp', value: 3000 },
      { type: 'mate', value: 1 },
    ] as const) {
      const annotations = buildReplayMoveAnnotations({
        analysisByFen: {
          [parent]: {
            bestMove: best,
            depth: 22,
            lines: [{ ...line({ pv: [best], value: 0 }), score: parentScore }],
          },
          [child]: {
            bestMove: 'reply',
            depth: 22,
            lines: [{ ...line({ pv: ['reply'], value: 0 }), score: { type: 'mate', value: -20 } }],
          },
        },
        bookPlies: new Set(),
        fenHistory: [parent, child],
        replayMoves: [{ ply: 1, san: move.san, uci: played, fen: child }],
      })
      expect(annotations[0].cpLoss).toBe(0)
      expect(annotations[0].label).toBe('Excellent')
    }
  })
  it('grades the final mating or stalemating move without fabricating a child search', () => {
    const parent = 'k7/8/1QK5/8/8/8/8/8 w - -'
    for (const [child, move, loss] of [
      ['k7/1Q6/2K5/8/8/8/8/8 b - -', 'b6b7', 0],
      ['k7/2Q5/2K5/8/8/8/8/8 b - -', 'b6c7', 500],
    ] as const) {
      const annotations = buildReplayMoveAnnotations({
        analysisByFen: {
          [parent]: {
            bestMove: 'b6b7',
            depth: 22,
            lines: [line({ depth: 22, value: 500, pv: ['b6b7'] })],
          },
        },
        bookPlies: new Set(),
        fenHistory: [parent, child],
        replayMoves: [{ ply: 61, san: move, uci: move, fen: child }],
      })
      expect(annotations[0].cpLoss).toBe(loss)
      expect(annotations[0].label).toBe(loss ? 'Blunder' : 'Best')
    }
  })

  it('preserves mate distance when comparing a forced line with its child', () => {
    const parent = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
    const child = 'rnbqkbnr/pppppppp/8/3P4/8/8/PPP1PPPP/RNBQKBNR b KQkq -'
    const annotations = buildReplayMoveAnnotations({
      analysisByFen: {
        [parent]: {
          bestMove: 'e2e4',
          depth: 22,
          lines: [
            { ...line({ depth: 22, pv: ['e2e4'], value: 0 }), score: { type: 'mate', value: 3 } },
          ],
        },
        [child]: {
          bestMove: 'e7e5',
          depth: 22,
          lines: [line({ depth: 22, pv: ['e7e5'], value: -1400 })],
        },
      },
      bookPlies: new Set(),
      fenHistory: [parent, child],
      replayMoves: [{ ply: 1, san: 'd4', uci: 'd2d4', fen: child }],
    })
    // Mate in 3 is 1,970, not a flat 2,000; the child stays inside DECISIVE_CP.
    expect(annotations[0].cpLoss).toBe(570)
  })
  it('keeps a shallow result or missing child pending even when the move matches', () => {
    for (const depth of [1, 12, 17]) {
      const annotations = buildReplayMoveAnnotations({
        analysisByFen: {
          start: {
            bestMove: 'e2e4',
            depth: 30,
            lines: [line({ depth, pv: ['e2e4'], value: 200 })],
          },
          after: {
            bestMove: 'e7e5',
            depth: 30,
            lines: [line({ depth: 22, pv: ['e7e5'], value: -100 })],
          },
        },
        bookPlies: new Set(),
        fenHistory: ['start', 'after'],
        replayMoves: [{ ply: 1, san: 'e4', uci: 'e2e4', fen: 'after' }],
      })
      expect(annotations[0]).toMatchObject({ cpLoss: null, label: null })
    }
    const annotations = buildReplayMoveAnnotations({
      analysisByFen: {
        start: {
          bestMove: 'e2e4',
          depth: 22,
          lines: [line({ depth: 22, pv: ['e2e4'], value: 30 })],
        },
      },
      bookPlies: new Set(),
      fenHistory: ['start', 'after'],
      replayMoves: [{ ply: 1, san: 'e4', uci: 'e2e4', fen: 'after' }],
    })
    expect(annotations[0]).toMatchObject({ cpLoss: null, label: null })
  })

  it('marks book moves before engine labels', () => {
    const annotations = buildReplayMoveAnnotations({
      analysisByFen: {
        start: {
          bestMove: 'e2e4',
          depth: 12,
          lines: [line({ pv: ['e2e4'], value: 30 })],
        },
      },
      bookPlies: new Set([1]),
      fenHistory: ['start', 'after-e4'],
      replayMoves: [{ ply: 1, san: 'e4', uci: 'e2e4', fen: 'after-e4' }],
    })

    expect(annotations[0]?.label).toBe('Book')
  })

  it('marks exact engine matches as best', () => {
    const annotations = buildReplayMoveAnnotations({
      analysisByFen: {
        start: {
          bestMove: 'e2e4',
          depth: 12,
          lines: [line({ pv: ['e2e4'], value: 24 })],
        },
        'after-e4': {
          bestMove: 'e7e5',
          depth: 12,
          lines: [line({ pv: ['e7e5'], value: 20 })],
        },
      },
      bookPlies: new Set<number>(),
      fenHistory: ['start', 'after-e4'],
      replayMoves: [{ ply: 1, san: 'e4', uci: 'e2e4', fen: 'after-e4' }],
    })

    expect(annotations[0]).toMatchObject({
      bestMove: 'e2e4',
      cpLoss: 0,
      label: 'Best',
    })
  })

  it('computes mover-centric centipawn loss for black moves', () => {
    const annotations = buildReplayMoveAnnotations({
      analysisByFen: {
        '8/8/8/8/8/8/8/8 b - -': {
          bestMove: 'e7e5',
          depth: 12,
          lines: [line({ pv: ['e7e5'], value: 40 })],
        },
        '8/8/8/8/8/8/8/8 w - -': {
          bestMove: 'g1f3',
          depth: 12,
          lines: [line({ pv: ['g1f3'], value: 140 })],
        },
      },
      bookPlies: new Set<number>(),
      fenHistory: ['8/8/8/8/8/8/8/8 b - -', '8/8/8/8/8/8/8/8 w - -'],
      replayMoves: [{ ply: 1, san: 'a5', uci: 'a7a5', fen: '8/8/8/8/8/8/8/8 w - -' }],
    })

    expect(annotations[0]).toMatchObject({
      cpLoss: 180,
      label: 'Mistake',
    })
  })

  it('keeps moves pending until both positions are analyzed', () => {
    const annotations = buildReplayMoveAnnotations({
      analysisByFen: {},
      bookPlies: new Set<number>(),
      fenHistory: ['start', 'after-e4'],
      replayMoves: [{ ply: 1, san: 'e4', uci: 'e2e4', fen: 'after-e4' }],
    })

    expect(annotations[0]).toMatchObject({
      cpLoss: null,
      label: null,
    })
  })

  it('does not invent book evidence from the move number', () => {
    const annotations = buildReplayMoveAnnotations({
      analysisByFen: {},
      bookPlies: new Set<number>(),
      fenHistory: ['start', 'after-e4'],
      implicitBookPlyLimit: 12,
      replayMoves: [{ ply: 1, san: 'e4', uci: 'e2e4', fen: 'after-e4' }],
    })

    expect(annotations[0]).toMatchObject({
      cpLoss: null,
      label: null,
    })
  })

  it('stops all later book labels after the first non-book ply', () => {
    const annotations = buildReplayMoveAnnotations({
      analysisByFen: {},
      bookPlies: new Set([1, 2, 4]),
      fenHistory: ['start', 'after-e4', 'after-e5', 'after-a3', 'after-nc6'],
      implicitBookPlyLimit: 12,
      replayMoves: [
        { ply: 1, san: 'e4', uci: 'e2e4', fen: 'after-e4' },
        { ply: 2, san: 'e5', uci: 'e7e5', fen: 'after-e5' },
        { ply: 3, san: 'a3', uci: 'a2a3', fen: 'after-a3' },
        { ply: 4, san: 'Nc6', uci: 'b8c6', fen: 'after-nc6' },
      ],
    })

    expect(annotations.map((a) => a.label)).toEqual(['Book', 'Book', null, null])
  })

  it('does not shield first-twelve loaded-game plies from engine mistake labels', () => {
    const annotations = buildReplayMoveAnnotations({
      analysisByFen: {
        start: {
          bestMove: 'e2e4',
          depth: 12,
          lines: [line({ pv: ['e2e4'], value: 100 })],
        },
        'after-a3': {
          bestMove: 'e7e5',
          depth: 12,
          lines: [line({ pv: ['e7e5'], value: 0 })],
        },
      },
      bookPlies: new Set([1]),
      fenHistory: ['start', 'after-a3'],
      implicitBookPlyLimit: 12,
      replayMoves: [{ ply: 1, san: 'a3', uci: 'a2a3', fen: 'after-a3' }],
    })

    expect(annotations[0]).toMatchObject({
      cpLoss: 100,
      label: 'Mistake',
    })
  })
})

describe('brilliant moves', () => {
  const PARENT = 'r1bq1rk1/ppp2ppp/5n2/8/8/3B1N2/PPP2PPP/R2Q1RK1 w - - 0 1'
  const CHILD = 'r1bq1rk1/ppp2ppB/5n2/8/8/5N2/PPP2PPP/R2Q1RK1 b - - 0 1'

  function annotate({
    reply = 'g8h7',
    parentValue = 150,
    lines,
  }: {
    reply?: string | null
    parentValue?: number
    lines?: UCIInfo[]
  } = {}) {
    return buildReplayMoveAnnotations({
      analysisByFen: {
        [PARENT]: {
          bestMove: 'd3h7',
          depth: 22,
          lines: lines ?? [line({ pv: ['d3h7'], value: parentValue })],
        },
        [CHILD]: {
          bestMove: reply,
          depth: 22,
          lines: reply ? [line({ pv: [reply], value: -100 })] : [],
        },
      },
      bookPlies: new Set(),
      fenHistory: [PARENT, CHILD],
      replayMoves: [{ ply: 21, san: 'Bxh7+', uci: 'd3h7', fen: CHILD }],
    })
  }

  it('awards a sacrifice that is still the best move', () => {
    // The Greek gift: Bxh7+ wins a pawn on this ply and loses the bishop on the
    // next. A sacrifice is never visible in the child position alone — that is
    // the ply where the player is briefly *up* material — so it has to be
    // judged after the opponent's reply.
    expect(annotate()[0].label).toBe('Brilliant')
  })

  it('does not award a plain capture that keeps the material', () => {
    // Same move, but the opponent does not recapture: nothing was sacrificed.
    expect(annotate({ reply: 'f6g4' })[0].label).toBe('Best')
  })

  it('does not award a sacrifice in an already winning position', () => {
    // Giving material back when completely winning is not brilliance.
    expect(annotate({ parentValue: 900 })[0].label).toBe('Best')
  })

  it('grades nothing when the reply is unknown rather than guessing', () => {
    // Without the child's evaluation there is no measured loss at all, so the
    // move is left ungraded rather than being called good or brilliant.
    expect(annotate({ reply: null })[0].label).toBeNull()
  })
})

describe('missed wins', () => {
  // A quiet middlegame position; only the evaluations matter here.
  const PARENT = 'r1bq1rk1/ppp2ppp/5n2/8/8/3B1N2/PPP2PPP/R2Q1RK1 w - - 0 1'

  function annotate({ before, after }: { before: number; after: number }) {
    const board = new Chess(PARENT)
    board.move({ from: 'f3', to: 'e5' })
    const child = board.fen()

    return buildReplayMoveAnnotations({
      analysisByFen: {
        [PARENT]: { bestMove: 'd1d8', depth: 22, lines: [line({ pv: ['d1d8'], value: before })] },
        // The child is Black to move, so its score is read from Black's side.
        [child]: { bestMove: 'f6g4', depth: 22, lines: [line({ pv: ['f6g4'], value: -after })] },
      },
      bookPlies: new Set(),
      fenHistory: [PARENT, child],
      replayMoves: [{ ply: 21, san: 'Ne5', uci: 'f3e5', fen: child }],
    })[0]
  }

  it('says the win was thrown away, not merely that the eval fell', () => {
    // +900 down to +20 is a blunder by cp loss alone; what matters for learning
    // is that the game was won before the move.
    expect(annotate({ before: 900, after: 20 }).label).toBe('Missed Win')
  })

  it('is still a plain blunder when the position was never winning', () => {
    expect(annotate({ before: 120, after: -400 }).label).toBe('Blunder')
  })

  it('does not fire while the position is still winning afterwards', () => {
    // A won game that stays won is not a missed win, however much eval was lost.
    expect(annotate({ before: 900, after: 600 }).label).not.toBe('Missed Win')
  })

  it('never replaces a good move', () => {
    // Small losses keep their own grade: a win surviving an inaccuracy is a win.
    expect(annotate({ before: 900, after: 860 }).label).not.toBe('Missed Win')
  })

  it('measures a tablebase-scale swing from the decisive cap, not in tens of pawns', () => {
    const parent = '8/2K5/3Pk3/2P5/8/8/7P/3r4 w - -'
    const board = new Chess(parent)
    const move = board.move({ from: 'c7', to: 'c6' })
    const child = board.fen()
    const annotations = buildReplayMoveAnnotations({
      analysisByFen: {
        [parent]: { bestMove: 'c7b6', depth: 22, lines: [line({ pv: ['c7b6'], value: 8000 })] },
        [child]: { bestMove: 'd1h1', depth: 22, lines: [line({ pv: ['d1h1'], value: 0 })] },
      },
      bookPlies: new Set(),
      fenHistory: [parent, child],
      replayMoves: [{ ply: 1, san: move.san, uci: 'c7c6', fen: child }],
    })
    expect(annotations[0].cpLoss).toBe(1500)
    expect(annotations[0].label).toBe('Missed Win')
  })
})
