import { describe, expect, it } from 'vite-plus/test'

import { estimateRate, formatDuration } from './progress-rate'

describe('estimateRate', () => {
  it('derives a rate from completions over elapsed time', () => {
    const { perMinute } = estimateRate({ completed: 10, total: 100, elapsedMs: 60_000 })
    expect(perMinute).toBeCloseTo(10)
  })

  it('projects the remaining work at that rate', () => {
    const { etaSeconds } = estimateRate({ completed: 10, total: 100, elapsedMs: 60_000 })
    // 90 positions left at 10/min is nine minutes.
    expect(etaSeconds).toBe(540)
  })

  it('has no estimate before anything finishes', () => {
    expect(estimateRate({ completed: 0, total: 100, elapsedMs: 5_000 })).toEqual({
      perMinute: null,
      etaSeconds: null,
    })
  })

  it('has no estimate before any time passes', () => {
    expect(estimateRate({ completed: 3, total: 100, elapsedMs: 0 }).perMinute).toBeNull()
  })

  it('reports zero remaining once the run is done', () => {
    expect(estimateRate({ completed: 100, total: 100, elapsedMs: 60_000 }).etaSeconds).toBe(0)
  })

  it('does not go negative when more finished than were counted', () => {
    expect(estimateRate({ completed: 120, total: 100, elapsedMs: 60_000 }).etaSeconds).toBe(0)
  })
})

describe('formatDuration', () => {
  it('does not pretend to precision under a minute', () => {
    expect(formatDuration(20)).toBe('under a minute')
  })

  it('reads in minutes below an hour', () => {
    expect(formatDuration(540)).toBe('9 min')
  })

  it('splits hours and minutes', () => {
    expect(formatDuration(3 * 3600 + 25 * 60)).toBe('3 hr 25 min')
  })

  it('drops the minutes when there are none', () => {
    expect(formatDuration(2 * 3600)).toBe('2 hr')
  })

  it('collapses to days once it is past a day', () => {
    expect(formatDuration(50 * 3600)).toBe('2 days')
  })

  it('refuses to guess at nonsense', () => {
    expect(formatDuration(Number.NaN)).toBe('unknown')
    expect(formatDuration(-5)).toBe('unknown')
  })
})
