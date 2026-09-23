// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vite-plus/test'

import { useEngineStore } from '@/store/engine-store'
import { useAnalysisProgress } from './use-analysis-progress'

afterEach(() => {
  vi.useRealTimers()
})

it('measures from the actual batch start when the progress display mounts late', () => {
  vi.useFakeTimers()
  vi.setSystemTime(60_000)
  useEngineStore.setState({
    replayQueueStartedAt: 0,
    replayQueueTotal: 24,
    replayQueueCompleted: 6,
    replayQueueActive: true,
  })
  const { result, unmount } = renderHook(() => useAnalysisProgress())
  try {
    expect(result.current.perMinute).toBe(6)
    expect(result.current.etaSeconds).toBe(180)
  } finally {
    unmount()
  }
})

it('resets the rate for a new batch of the same size even when React batches the reset', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  useEngineStore.setState({
    replayQueueStartedAt: 0,
    replayQueueTotal: 24,
    replayQueueCompleted: 0,
    replayQueueActive: true,
  })
  const { result, unmount } = renderHook(() => useAnalysisProgress())
  try {
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    act(() => {
      useEngineStore.setState({ replayQueueTotal: 0, replayQueueStartedAt: null })
      useEngineStore.setState({ replayQueueTotal: 24, replayQueueStartedAt: 60_000 })
    })
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    act(() => useEngineStore.setState({ replayQueueCompleted: 3 }))
    expect(result.current.perMinute).toBe(6)
    expect(result.current.etaSeconds).toBe(210)
  } finally {
    unmount()
  }
})
