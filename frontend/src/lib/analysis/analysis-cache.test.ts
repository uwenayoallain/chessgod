import { describe, expect, it } from 'vitest'

import { needsEngineAnalysis } from './analysis-cache'

describe('needsEngineAnalysis', () => {
  it('requires analysis when there is no cached depth', () => {
    expect(needsEngineAnalysis(null, 12, false)).toBe(true)
  })

  it('reuses cached analysis when it already meets the requested depth', () => {
    expect(needsEngineAnalysis(18, 12, false)).toBe(false)
  })

  it('requests a deeper analysis when the cached depth is lower', () => {
    expect(needsEngineAnalysis(12, 18, false)).toBe(true)
  })

  it('forces analysis when explicitly requested', () => {
    expect(needsEngineAnalysis(18, 18, true)).toBe(true)
  })
})
