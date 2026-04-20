import { describe, expect, test } from 'vitest'

import { getAppAccessState } from '../src/lib/app-access'
import { getEngineStatusMessage } from '../src/lib/engine-status'

describe('getAppAccessState', () => {
  test('returns missing_username when no player is selected', () => {
    expect(getAppAccessState({ username: null, isLoading: false, totalGames: null }).state).toBe('missing_username')
  })

  test('returns empty when a player exists but no imported games are available', () => {
    expect(getAppAccessState({ username: 'hikaru', isLoading: false, totalGames: 0 }).state).toBe('empty')
  })

  test('returns ready when imported games exist', () => {
    expect(getAppAccessState({ username: 'hikaru', isLoading: false, totalGames: 12 }).state).toBe('ready')
  })
})

describe('getEngineStatusMessage', () => {
  test('passes through known initialization errors', () => {
    expect(
      getEngineStatusMessage({
        currentDepth: 0,
        enabled: true,
        error: 'Failed to load NNUE: 404',
        hasAttempted: true,
        isAnalyzing: false,
        isLoadingNnue: false,
        isReady: false,
      }),
    ).toBe('Failed to load NNUE: 404')
  })

  test('passes through unknown errors verbatim', () => {
    expect(
      getEngineStatusMessage({
        currentDepth: 0,
        enabled: true,
        error: 'Something unexpected happened.',
        hasAttempted: true,
        isAnalyzing: false,
        isLoadingNnue: false,
        isReady: false,
      }),
    ).toBe('Something unexpected happened.')
  })

  test('returns engine off when disabled', () => {
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

  test('returns nnue loading state', () => {
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

  test('returns depth-aware ready message', () => {
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
