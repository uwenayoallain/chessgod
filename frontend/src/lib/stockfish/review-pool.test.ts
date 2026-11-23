import { describe, expect, it, vi } from 'vite-plus/test'

import {
  contiguousChunks,
  reviewPoolSize,
  runReviewPool,
  takeJob,
  type PoolEngine,
} from './review-pool'
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
    expect(results.sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['fine', true],
      ['stuck', false],
    ])
  })

  it('walks each stretch of the game backwards, then helps the others', async () => {
    const { made, create } = fakeEngines((fen) => (fen === 'g-5' ? 60 : 1))
    const jobs = Array.from({ length: 6 }, (_, i) => ({ fen: `g-${i}`, depth: 18 }))
    await runReviewPool({
      jobs,
      size: 2,
      create,
      hash: 32,
      signal: new AbortController().signal,
      onResult: () => {},
    })
    // The first engine has g-0..g-2 and the second g-3..g-5, each from its end:
    // a child searched before its parent leaves the parent's subtree in the
    // hash. The second is held up on g-5, so the first takes its g-4 and g-3.
    expect(made[0].searched).toEqual(['g-2', 'g-1', 'g-0', 'g-4', 'g-3'])
    expect(made[1].searched).toEqual(['g-5'])
  })

  it('passes each position its time limit', async () => {
    const { made, create } = fakeEngines()
    await runReviewPool({
      jobs: [
        { fen: 'a', depth: 20 },
        { fen: 'b', depth: 22, movetimeMs: 16_000 },
      ],
      size: 1,
      create,
      hash: 32,
      movetimeMs: 4_000,
      signal: new AbortController().signal,
      onResult: () => {},
    })
    expect(made[0].play).toHaveBeenCalledWith('a', { depth: 20, multiPV: 1, movetime: 4_000 })
    expect(made[0].play).toHaveBeenCalledWith('b', { depth: 22, multiPV: 1, movetime: 16_000 })
  })

  it('keeps what an overrunning search reached when it is deep enough', async () => {
    let settle: ((lines: UCIInfo[] | null) => void) | undefined
    const engine: PoolEngine = {
      init: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
      play: vi.fn(() => new Promise<UCIInfo[] | null>((resolve) => (settle = resolve))),
      finish: vi.fn(() => {
        settle?.([{ ...line('deep'), depth: 19 }])
        return true
      }),
    }
    const results: Array<UCIInfo[] | null> = []
    await runReviewPool({
      jobs: [{ fen: 'deep', depth: 20 }],
      size: 1,
      create: () => engine,
      hash: 32,
      timeoutMs: 10,
      signal: new AbortController().signal,
      onResult: (_, lines) => results.push(lines),
    })
    expect(engine.finish).toHaveBeenCalledOnce()
    expect(engine.stop).not.toHaveBeenCalled()
    expect(results[0]?.[0].depth).toBe(19)
  })

  it('tries a position once more when it comes back empty or too shallow', async () => {
    const answers: Array<UCIInfo[] | null> = [
      null,
      [line('x')],
      [{ ...line('y'), depth: 12 }],
      [{ ...line('y'), depth: 18 }],
    ]
    const play = vi.fn(async () => answers.shift() ?? null)
    const results: Array<[string, number | null]> = []
    await runReviewPool({
      jobs: [
        { fen: 'y', depth: 20 },
        { fen: 'x', depth: 20 },
      ],
      size: 1,
      create: () => ({ init: vi.fn(), stop: vi.fn(), destroy: vi.fn(), play }),
      hash: 32,
      movetimeMs: 1_000,
      signal: new AbortController().signal,
      onResult: (job, lines) => results.push([job.fen, lines?.[0].depth ?? null]),
    })
    expect(results).toEqual([
      ['x', 18],
      ['y', 18],
    ])
    // The shallow one is given twice the time on its second try.
    expect(play).toHaveBeenLastCalledWith('y', { depth: 20, multiPV: 1, movetime: 2_000 })
  })

  it('leaves no abort listener behind per position', async () => {
    const { create } = fakeEngines(() => 1)
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await runReviewPool({
      jobs: Array.from({ length: 5 }, (_, i) => ({ fen: `fen-${i}`, depth: 18 })),
      size: 2,
      create,
      hash: 32,
      signal: controller.signal,
      onResult: () => {},
    })
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length)
  })
})

describe('contiguousChunks', () => {
  it('searches an urgent position before the next of its own stretch', async () => {
    const { made, create } = fakeEngines()
    const jobs = Array.from({ length: 4 }, (_, i) => ({ fen: `fen-${i}`, depth: 18 }))
    const urgent: Array<{ fen: string; depth: number; multiPV?: number }> = []
    const results: string[] = []
    await runReviewPool({
      jobs,
      size: 1,
      create,
      hash: 16,
      signal: new AbortController().signal,
      priority: () => urgent.shift() ?? null,
      onResult: (job) => {
        results.push(job.fen)
        // The player steps onto a side line after the first position lands.
        if (results.length === 1) urgent.push({ fen: 'side-line', depth: 26, multiPV: 2 })
      },
    })
    expect(results).toEqual(['fen-3', 'side-line', 'fen-2', 'fen-1', 'fen-0'])
    expect(made[0].play).toHaveBeenCalledWith('side-line', { depth: 26, multiPV: 2 })
  })

  it('splits the game into stretches that differ by at most one position', () => {
    expect(contiguousChunks([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([
      [1, 2, 3],
      [4, 5],
      [6, 7],
    ])
    expect(contiguousChunks([1], 3)).toEqual([[1], [], []])
  })

  it('takes from its own end, then from the end of the longest other', () => {
    const chunks = [[1], [2, 3, 4], [5, 6]]
    expect(takeJob(chunks, 0)).toBe(1)
    expect(takeJob(chunks, 0)).toBe(4)
    expect(takeJob(chunks, 0)).toBe(3)
    expect(takeJob(chunks, 0)).toBe(6)
  })
})

describe('reviewPoolSize', () => {
  it('uses half the cores, at most three, leaving a core for the page', () => {
    expect(reviewPoolSize(8)).toBe(3)
    expect(reviewPoolSize(4)).toBe(2)
    expect(reviewPoolSize(2)).toBe(1)
    expect(reviewPoolSize(1)).toBe(1)
    expect(reviewPoolSize(32)).toBe(3)
  })

  it('runs fewer engines on a device that reports little memory', () => {
    expect(reviewPoolSize(8, 8)).toBe(3)
    expect(reviewPoolSize(8, 2)).toBe(2)
    expect(reviewPoolSize(8, 1)).toBe(1)
    expect(reviewPoolSize(8, 0.5)).toBe(1)
  })
})
