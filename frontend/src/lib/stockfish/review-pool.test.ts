import { describe, expect, it, vi } from 'vite-plus/test'

import {
  contiguousChunks,
  createWarmPool,
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

describe('runReviewPool with a borrowed engine', () => {
  function borrowed(threads: number, revoke?: AbortSignal) {
    const { made, create } = fakeEngines()
    const engine = create()
    made.length = 0
    const release = vi.fn()
    return {
      engine,
      made,
      create,
      lend: { engine, threads, release, ...(revoke ? { revoke } : {}) },
    }
  }

  it('counts its threads against the pool and hands it back, never destroyed', async () => {
    const { engine, made, create, lend } = borrowed(2)
    const results: string[] = []
    await runReviewPool({
      jobs: Array.from({ length: 6 }, (_, i) => ({ fen: `fen-${i}`, depth: 18 })),
      size: 3,
      create,
      borrow: lend,
      hash: 32,
      signal: new AbortController().signal,
      onResult: (job) => results.push(job.fen),
    })
    expect(results).toHaveLength(6)
    // Two threads stand in for two of the three engines: one is created.
    expect(made).toHaveLength(1)
    expect(engine.searched.length).toBeGreaterThan(0)
    expect(engine.init).not.toHaveBeenCalled()
    expect(engine.destroy).not.toHaveBeenCalled()
    expect(lend.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('creates nothing when the borrowed engine fills the budget', async () => {
    const { engine, made, create, lend } = borrowed(2)
    await runReviewPool({
      jobs: Array.from({ length: 3 }, (_, i) => ({ fen: `fen-${i}`, depth: 18 })),
      size: 1,
      create,
      borrow: lend,
      hash: 32,
      signal: new AbortController().signal,
      onResult: () => {},
    })
    expect(made).toHaveLength(0)
    expect(engine.searched).toHaveLength(3)
  })

  it('hands it back when its search had to be abandoned', async () => {
    const lend = {
      engine: {
        init: vi.fn(),
        stop: vi.fn(),
        destroy: vi.fn(),
        play: vi.fn(() => new Promise<UCIInfo[] | null>(() => {})),
      },
      threads: 1,
      release: vi.fn(),
    }
    await runReviewPool({
      jobs: [{ fen: 'stuck', depth: 18 }],
      size: 1,
      create: () => {
        throw new Error('no engine should be created')
      },
      borrow: lend,
      hash: 32,
      timeoutMs: 5,
      signal: new AbortController().signal,
      onResult: () => {},
    })
    expect(lend.release).toHaveBeenCalledExactlyOnceWith(false)
    expect(lend.engine.destroy).not.toHaveBeenCalled()
  })

  it('gives it back mid-search when revoked, and finishes on engines of its own', async () => {
    const revoke = new AbortController()
    let settleLent: ((lines: UCIInfo[] | null) => void) | undefined
    const lentEngine: PoolEngine = {
      init: vi.fn(),
      destroy: vi.fn(),
      // A stopped search settles empty, as the real engine's does.
      stop: vi.fn(() => settleLent?.(null)),
      play: vi.fn(() => new Promise<UCIInfo[] | null>((resolve) => (settleLent = resolve))),
    }
    const release = vi.fn()
    const { made, create } = fakeEngines(() => 5)
    const results: string[] = []
    const run = runReviewPool({
      jobs: Array.from({ length: 4 }, (_, i) => ({ fen: `fen-${i}`, depth: 18 })),
      size: 3,
      create,
      borrow: { engine: lentEngine, threads: 2, revoke: revoke.signal, release },
      hash: 32,
      signal: new AbortController().signal,
      onResult: (job) => results.push(job.fen),
    })
    await new Promise((resolve) => setTimeout(resolve, 1))
    const cut = (lentEngine.play as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    revoke.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Handed back at once, before the review is over.
    expect(release).toHaveBeenCalledExactlyOnceWith(true)
    await run
    expect(lentEngine.play).toHaveBeenCalledOnce()
    expect(results.sort()).toEqual(['fen-0', 'fen-1', 'fen-2', 'fen-3'])
    // The position cut short was searched by another engine, and its two
    // threads came back as two engines of the pool's own.
    expect(made.flatMap((engine) => engine.searched)).toContain(cut)
    expect(made.length).toBeGreaterThanOrEqual(2)
    expect(made.length).toBeLessThanOrEqual(3)
    expect(lentEngine.destroy).not.toHaveBeenCalled()
  })

  it('returns an engine asked back before the run starts without using it', async () => {
    const revoke = new AbortController()
    revoke.abort()
    const { engine, made, create, lend } = borrowed(2, revoke.signal)
    await runReviewPool({
      jobs: Array.from({ length: 4 }, (_, i) => ({ fen: `fen-${i}`, depth: 18 })),
      size: 3,
      create,
      borrow: lend,
      hash: 32,
      signal: new AbortController().signal,
      onResult: () => {},
    })
    expect(engine.play).not.toHaveBeenCalled()
    expect(lend.release).toHaveBeenCalledExactlyOnceWith(true)
    expect(made).toHaveLength(3)
  })

  it('stops a borrowed engine on abort and still hands it back, not destroyed', async () => {
    const { engine, create, lend } = borrowed(1)
    const controller = new AbortController()
    const run = runReviewPool({
      jobs: Array.from({ length: 4 }, (_, i) => ({ fen: `fen-${i}`, depth: 18 })),
      size: 2,
      create,
      borrow: lend,
      hash: 32,
      signal: controller.signal,
      onResult: () => {},
    })
    await new Promise((resolve) => setTimeout(resolve, 1))
    controller.abort()
    await run
    expect(engine.stop).toHaveBeenCalled()
    expect(engine.destroy).not.toHaveBeenCalled()
    expect(lend.release).toHaveBeenCalledOnce()
  })

  it('tells `retire` which engines are still sound', async () => {
    const { create } = fakeEngines((fen) => (fen === 'stuck' ? 1_000 : 1))
    const retire = vi.fn()
    await runReviewPool({
      jobs: [
        { fen: 'stuck', depth: 18 },
        { fen: 'fine', depth: 18 },
      ],
      size: 2,
      create,
      retire,
      hash: 32,
      timeoutMs: 20,
      signal: new AbortController().signal,
      onResult: () => {},
    })
    const health = retire.mock.calls.map(([, healthy]) => healthy)
    expect(health).toHaveLength(2)
    expect(health).toContain(true)
    expect(health).toContain(false)
  })
})

describe('createWarmPool', () => {
  function engines() {
    const made: Array<PoolEngine & { destroy: ReturnType<typeof vi.fn> }> = []
    const create = () => {
      const engine = { init: vi.fn(), play: vi.fn(), stop: vi.fn(), destroy: vi.fn() }
      made.push(engine)
      return engine
    }
    return { made, create }
  }

  it('reuses an engine handed back, and lets it go after the idle time', () => {
    vi.useFakeTimers()
    try {
      const { made, create } = engines()
      const pool = createWarmPool({ create, idleMs: 50_000 })
      const first = pool.acquire()
      pool.release(first, true)
      expect(pool.acquire()).toBe(first)
      pool.release(first, true)
      vi.advanceTimersByTime(49_000)
      expect(first.destroy).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2_000)
      expect(first.destroy).toHaveBeenCalledOnce()
      expect(pool.idleCount).toBe(0)
      expect(pool.acquire()).not.toBe(first)
      expect(made).toHaveLength(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never keeps an engine that is not sound', () => {
    vi.useFakeTimers()
    try {
      const { create } = engines()
      const pool = createWarmPool({ create, idleMs: 50_000 })
      const engine = pool.acquire()
      pool.release(engine, false)
      expect(engine.destroy).toHaveBeenCalledOnce()
      expect(pool.idleCount).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops idle engines now, and after a reset destroys those still out on return', () => {
    vi.useFakeTimers()
    try {
      const { create } = engines()
      const pool = createWarmPool({ create, idleMs: 50_000 })
      const idle = pool.acquire()
      const out = pool.acquire()
      pool.release(idle, true)
      pool.dropIdle()
      expect(idle.destroy).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)

      const kept = pool.acquire()
      pool.reset()
      // Handed out before the reset: a pool still settling must not bring
      // its engines back warm after the engine was switched off.
      pool.release(out, true)
      pool.release(kept, true)
      expect(out.destroy).toHaveBeenCalledOnce()
      expect(kept.destroy).toHaveBeenCalledOnce()
      expect(pool.idleCount).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
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
