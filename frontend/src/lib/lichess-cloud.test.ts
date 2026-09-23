import { describe, expect, it, vi } from 'vite-plus/test'

import { LichessCloudClient, normalizeLichessPv } from './lichess-cloud'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

describe('Lichess cloud evaluation client', () => {
  it('normalizes legal PVs and UCI_Chess960 castling notation', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'
    expect(normalizeLichessPv(fen, 'e1h1 e8a8')).toEqual(['e1g1', 'e8c8'])
    expect(normalizeLichessPv(START_FEN, 'e2e5')).toBeNull()
  })

  it('parses a cloud hit and limits the returned variations', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            depth: 36,
            knodes: 1234,
            pvs: [
              { cp: 24, moves: 'e2e4 e7e5' },
              { cp: 18, moves: 'd2d4 d7d5' },
            ],
          }),
          { status: 200 },
        ),
    )
    const client = new LichessCloudClient({ fetchFn })

    await expect(client.evaluate(START_FEN, 1)).resolves.toEqual({
      depth: 36,
      knodes: 1234,
      lines: [{ evalCp: 24, evalMate: null, moves: ['e2e4', 'e7e5'] }],
      source: 'lichess-cloud',
    })
  })

  it('caches 404 misses for the page session', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 404 }))
    const client = new LichessCloudClient({ fetchFn })

    await expect(client.evaluate(START_FEN)).resolves.toBeNull()
    await expect(client.evaluate(START_FEN)).resolves.toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('opens a cooldown circuit after a rate-limit response', async () => {
    let now = 1_000
    const fetchFn = vi.fn(
      async () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }),
    )
    const client = new LichessCloudClient({ fetchFn, now: () => now })

    await expect(client.evaluate(START_FEN)).resolves.toBeNull()
    now += 60_000
    await expect(client.evaluate(`${START_FEN} `)).resolves.toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('falls back without another request after the browser daily budget is used', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 500 }))
    const client = new LichessCloudClient({
      dailyRequestLimit: 1,
      fetchFn,
      minRequestIntervalMs: 0,
    })

    await expect(client.evaluate(START_FEN)).resolves.toBeNull()
    await expect(client.evaluate(`${START_FEN} `)).resolves.toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('never overlaps cloud requests', async () => {
    let activeRequests = 0
    let maxActiveRequests = 0
    const releases: Array<() => void> = []
    const fetchFn = vi.fn(async () => {
      activeRequests += 1
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      await new Promise<void>((resolve) => releases.push(resolve))
      activeRequests -= 1
      return new Response('{}', { status: 500 })
    })
    const client = new LichessCloudClient({ fetchFn, minRequestIntervalMs: 0 })

    const first = client.evaluate(START_FEN)
    const second = client.evaluate(`${START_FEN} `)
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1))
    releases.shift()?.()
    await first
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2))
    releases.shift()?.()
    await second

    expect(maxActiveRequests).toBe(1)
  })
})
