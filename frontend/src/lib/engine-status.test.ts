import { describe, expect, it } from 'vite-plus/test'

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
    ).toBe('Loading analysis model…')
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
    ).toBe('Ready at depth 22.')
  })

  it('names the active analysis mode while searching', () => {
    expect(
      getEngineStatusMessage({
        activeMode: 'quick',
        currentDepth: 12,
        enabled: true,
        error: null,
        hasAttempted: true,
        isAnalyzing: true,
        isLoadingNnue: false,
        isReady: true,
      }),
    ).toBe('Quick analysis d12…')
  })
})
