import { describe, expect, it } from 'vitest'

import { getEngineStatusMessage } from './engine-status'

describe('getEngineStatusMessage', () => {
  it('reports when the engine is disabled', () => {
    expect(
      getEngineStatusMessage({
        currentDepth: 0,
        enabled: false,
        error: null,
        hasAttempted: false,
        isAnalyzing: false,
        isLoadingNnue: false,
        isReady: false,
      }),
    ).toBe('Engine off.')
  })

  it('reports nnue loading separately from startup', () => {
    expect(
      getEngineStatusMessage({
        currentDepth: 0,
        enabled: true,
        error: null,
        hasAttempted: true,
        isAnalyzing: true,
        isLoadingNnue: true,
        isReady: false,
      }),
    ).toBe('Loading NNUE…')
  })

  it('reports the latest reached depth when ready', () => {
    expect(
      getEngineStatusMessage({
        currentDepth: 22,
        enabled: true,
        error: null,
        hasAttempted: true,
        isAnalyzing: false,
        isLoadingNnue: false,
        isReady: true,
      }),
    ).toBe('Engine ready at depth 22.')
  })
})
