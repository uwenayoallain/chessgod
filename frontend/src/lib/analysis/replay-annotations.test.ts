import { describe, expect, it } from 'vitest'

import { buildReplayMoveAnnotations } from './replay-annotations'
import type { UCIInfo } from '@/lib/stockfish/uci'

function line({
  depth = 12,
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
      cpLoss: 4,
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

  it('treats the first twelve loaded-game plies as book when not engine-flagged', () => {
    const annotations = buildReplayMoveAnnotations({
      analysisByFen: {},
      bookPlies: new Set<number>(),
      fenHistory: ['start', 'after-e4'],
      implicitBookPlyLimit: 12,
      replayMoves: [{ ply: 1, san: 'e4', uci: 'e2e4', fen: 'after-e4' }],
    })

    expect(annotations[0]).toMatchObject({
      cpLoss: null,
      label: 'Book',
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
