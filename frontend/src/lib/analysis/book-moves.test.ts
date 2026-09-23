import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { clearTheoryCache, prefetchBookPlies } from './book-moves'

describe('prefetchBookPlies', () => {
  beforeEach(() => clearTheoryCache())

  it('marks consecutive book plies and stops at first deviation', async () => {
    const fetchTheoryCompare = vi
      .fn()
      .mockResolvedValueOnce({
        master_moves: [
          { san: 'e4', uci: 'e2e4' },
          { san: 'd4', uci: 'd2d4' },
        ],
      })
      .mockResolvedValueOnce({ master_moves: [{ san: 'Nc6', uci: 'b8c6' }] })

    const result = await prefetchBookPlies({
      fenHistory: ['start', 'after-e4', 'after-e5', 'after-nf3'],
      fetchTheoryCompare,
      replayMoves: [
        { ply: 1, san: 'e4', uci: 'e2e4', fen: 'after-e4' },
        { ply: 2, san: 'e5', uci: 'e7e5', fen: 'after-e5' },
        { ply: 3, san: 'Nf3', uci: 'g1f3', fen: 'after-nf3' },
      ],
    })

    expect(result).toEqual({ hadErrors: false, plies: [1] })
    expect(fetchTheoryCompare).toHaveBeenCalledTimes(2)
  })

  it('marks all plies when entire game is book', async () => {
    const fetchTheoryCompare = vi
      .fn()
      .mockResolvedValueOnce({ master_moves: [{ san: 'e4', uci: 'e2e4' }] })
      .mockResolvedValueOnce({ master_moves: [{ san: 'e5', uci: 'e7e5' }] })

    const result = await prefetchBookPlies({
      fenHistory: ['start', 'after-e4', 'after-e5'],
      fetchTheoryCompare,
      replayMoves: [
        { ply: 1, san: 'e4', uci: 'e2e4', fen: 'after-e4' },
        { ply: 2, san: 'e5', uci: 'e7e5', fen: 'after-e5' },
      ],
    })

    expect(result).toEqual({ hadErrors: false, plies: [1, 2] })
  })
})
