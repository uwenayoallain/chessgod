import { describe, expect, it, vi } from 'vite-plus/test'

import { reviewPoolSize, runReviewPool, type PoolEngine } from './review-pool'
import type { UCIInfo } from './uci'

function line(fen: string): UCIInfo {
  return {
    depth: 18,
    seldepth: null,
    multipv: 1,
    score: { type: 'cp', value: fen.length },
    nodes: null,
    nps: null,
    time: null,
    pv: ['e2e4'],
  }
}

function fakeEngines(delayFor: (fen: string) => number = () => 5) {
  const made: Array<PoolEngine & { searched: string[]; running: number; peak: number }> = []
  let concurrent = 0
  let peak = 0
  const create = () => {
    const engine = {
      searched: [] as string[],
      running: 0,
      peak: 0,
      init: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
      play: vi.fn(async (fen: string) => {
        engine.searched.push(fen)
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await new Promise((resolve) => setTimeout(resolve, delayFor(fen)))
        concurrent -= 1
        return [line(fen)]
      }),
    }
    made.push(engine)
    return engine
  }
  return { made, create, peak: () => peak }
}

describe('runReviewPool', () => {
  it('searches positions side by side and reports every one', async () => {
    const { made, create, peak } = fakeEngines()
    const jobs = Array.from({ length: 10 }, (_, i) => ({ fen: `fen-${i}`, depth: 18 }))
    const results: string[] = []
    await runReviewPool({
      jobs,
      size: 3,
      create,
      hash: 32,
      signal: new AbortController().signal,
      onResult: (job, lines) => {
        expect(lines?.[0].pv[0]).toBe('e2e4')
        results.push(job.fen)
      },
    })
    expect(results.sort()).toEqual(jobs.map((job) => job.fen).sort())
    expect(made).toHaveLength(3)
    expect(peak()).toBe(3)
    // Each position searched once, each engine single-threaded, all released.
    expect(made.flatMap((engine) => engine.searched).sort()).toEqual(results)
    for (const engine of made) {
      expect(engine.init).toHaveBeenCalledWith({ hash: 32, threads: 1 })
      expect(engine.destroy).toHaveBeenCalledOnce()
    }
  })

  it('never starts more engines than there are positions', async () => {
    const { made, create } = fakeEngines()
    await runReviewPool({
      jobs: [{ fen: 'only', depth: 18 }],
      size: 4,
      create,
      hash: 32,
      signal: new AbortController().signal,
      onResult: () => {},
    })
    expect(made).toHaveLength(1)
  })

  it('stops, reports nothing more and releases the engines when aborted', async () => {
    const { made, create } = fakeEngines(() => 20)
    const controller = new AbortController()
    const results: string[] = []
    const run = runReviewPool({
      jobs: Array.from({ length: 8 }, (_, i) => ({ fen: `fen-${i}`, depth: 18 })),
      size: 2,
      create,
      hash: 32,
      signal: controller.signal,
      onResult: (job) => results.push(job.fen),
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    await run
    expect(results).toEqual([])
    for (const engine of made) {
      expect(engine.stop).toHaveBeenCalled()
      expect(engine.destroy).toHaveBeenCalledOnce()
    }
  })

  it('gives up on a position that never finishes, and moves on', async () => {
    const { create } = fakeEngines((fen) => (fen === 'stuck' ? 1_000 : 1))
    const results: Array<[string, boolean]> = []
    await runReviewPool({
      jobs: [
        { fen: 'stuck', depth: 18 },
        { fen: 'fine', depth: 18 },
      ],
      size: 1,
      create,
      hash: 32,
      signal: new AbortController().signal,
      timeoutMs: 20,
      onResult: (job, lines) => results.push([job.fen, lines !== null]),
    })
    expect(results).toEqual([
      ['stuck', false],
      ['fine', true],
    ])
  })
})

describe('reviewPoolSize', () => {
  it('uses half the cores, at most four', () => {
    expect(reviewPoolSize(8)).toBe(4)
    expect(reviewPoolSize(4)).toBe(2)
    expect(reviewPoolSize(2)).toBe(1)
    expect(reviewPoolSize(1)).toBe(1)
    expect(reviewPoolSize(32)).toBe(4)
  })
})
