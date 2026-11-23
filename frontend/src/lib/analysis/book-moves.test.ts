import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  BOOK_PREFETCH_BATCH,
  clearTheoryCache,
  fetchCachedTheoryCompare,
  MAX_THEORY_CACHE_ENTRIES,
  prefetchBookPlies,
} from './book-moves'

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
    // The opening's positions are asked for together, then read in order.
    expect(fetchTheoryCompare).toHaveBeenCalledTimes(3)
  })

  it('asks for the opening a batch at a time, and reads no further than the book', async () => {
    let inFlight = 0
    let peak = 0
    const fetchTheoryCompare = vi.fn(async (fen: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      const ply = Number(fen.slice(4))
      // In book until ply 8, where the game leaves it.
      return {
        master_moves: ply < 7 ? [{ san: `m${ply + 1}`, uci: null }] : [{ san: 'x', uci: null }],
      }
    })
    const fenHistory = Array.from({ length: 41 }, (_, i) => `fen-${i}`)
    const replayMoves = Array.from({ length: 40 }, (_, i) => ({
      ply: i + 1,
      san: `m${i + 1}`,
      uci: `u${i + 1}`,
      fen: `fen-${i + 1}`,
    }))

    const result = await prefetchBookPlies({ fenHistory, fetchTheoryCompare, replayMoves })

    expect(result).toEqual({ hadErrors: false, plies: [1, 2, 3, 4, 5, 6, 7] })
    expect(peak).toBe(BOOK_PREFETCH_BATCH)
    // Two batches, not the whole prefetch window.
    expect(fetchTheoryCompare).toHaveBeenCalledTimes(BOOK_PREFETCH_BATCH * 2)
  })

  it('stops asking once the caller has moved on to another game', async () => {
    let stale = false
    const fetchTheoryCompare = vi.fn(async (fen: string) => {
      stale = true
      return { master_moves: [{ san: `m${Number(fen.slice(4)) + 1}`, uci: null }] }
    })
    const fenHistory = Array.from({ length: 41 }, (_, i) => `fen-${i}`)
    const replayMoves = Array.from({ length: 40 }, (_, i) => ({
      ply: i + 1,
      san: `m${i + 1}`,
      uci: `u${i + 1}`,
      fen: `fen-${i + 1}`,
    }))

    const result = await prefetchBookPlies({
      fenHistory,
      fetchTheoryCompare,
      replayMoves,
      isStale: () => stale,
    })

    expect(result.plies).toEqual([])
    expect(fetchTheoryCompare).toHaveBeenCalledTimes(BOOK_PREFETCH_BATCH)
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

  it('bounds theoryCache to MAX_THEORY_CACHE_ENTRIES with LRU eviction', async () => {
    const fetchTheoryCompare = vi.fn(async (fen: string) => ({
      master_moves: [{ san: fen, uci: 'e2e4' }],
    }))

    for (let i = 0; i < MAX_THEORY_CACHE_ENTRIES; i += 1) {
      await fetchCachedTheoryCompare(`fen-${i}`, fetchTheoryCompare)
    }
    expect(fetchTheoryCompare).toHaveBeenCalledTimes(MAX_THEORY_CACHE_ENTRIES)

    // Access fen-0 so it becomes most recently used and fen-1 is the oldest.
    await fetchCachedTheoryCompare('fen-0', fetchTheoryCompare)
    expect(fetchTheoryCompare).toHaveBeenCalledTimes(MAX_THEORY_CACHE_ENTRIES)

    // Adding one more entry evicts fen-1.
    await fetchCachedTheoryCompare('fen-overflow', fetchTheoryCompare)
    expect(fetchTheoryCompare).toHaveBeenCalledTimes(MAX_THEORY_CACHE_ENTRIES + 1)

    // fen-0 is still cached.
    await fetchCachedTheoryCompare('fen-0', fetchTheoryCompare)
    expect(fetchTheoryCompare).toHaveBeenCalledTimes(MAX_THEORY_CACHE_ENTRIES + 1)

    // fen-1 was evicted and must be fetched again.
    await fetchCachedTheoryCompare('fen-1', fetchTheoryCompare)
    expect(fetchTheoryCompare).toHaveBeenCalledTimes(MAX_THEORY_CACHE_ENTRIES + 2)
  })
})
