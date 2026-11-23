import { describe, expect, it, vi } from 'vite-plus/test'

import { getCurrentRequestId, getTelemetryNowMs, setCurrentRequestId } from './telemetry'

describe('telemetry helpers', () => {
  it('returns a numeric monotonic-ish timestamp', () => {
    const first = getTelemetryNowMs()
    const second = getTelemetryNowMs()

    expect(typeof first).toBe('number')
    expect(typeof second).toBe('number')
    expect(second).toBeGreaterThanOrEqual(first)
  })

  it('can be safely called when performance.now exists', () => {
    const spy = vi.spyOn(globalThis.performance, 'now').mockReturnValue(123.45)

    expect(getTelemetryNowMs()).toBe(123.45)

    spy.mockRestore()
  })

  it('stores and reads current request id', () => {
    setCurrentRequestId('abc-123')
    expect(getCurrentRequestId()).toBe('abc-123')

    setCurrentRequestId(null)
    expect(getCurrentRequestId()).toBeNull()
  })
})
