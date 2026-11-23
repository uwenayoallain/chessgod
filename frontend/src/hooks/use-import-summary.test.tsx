// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { useImportSummary } from './use-import-summary'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))

vi.mock('@/lib/api', () => ({ api: { get: apiGet } }))

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const SUMMARY = {
  username: 'saint_uwe',
  total_games: 4212,
  date_range: { from: null, to: null },
  games_by_time_class: {},
}

describe('useImportSummary', () => {
  afterEach(() => vi.clearAllMocks())

  it('reports the library once it loads', async () => {
    apiGet.mockResolvedValue({ data: SUMMARY })
    const { result } = renderHook(() => useImportSummary('saint_uwe'), { wrapper })
    await waitFor(() => expect(result.current.data?.total_games).toBe(4212))
  })

  it('keeps the previous summary while a resync refetches', async () => {
    // Starting an import changes the refresh key, which swaps the query key.
    // Without kept data the summary blinks to null mid-resync, the app reads
    // that as "no games" and throws the user back to the import form.
    apiGet.mockResolvedValue({ data: SUMMARY })
    const { result, rerender } = renderHook(({ key }) => useImportSummary('saint_uwe', key), {
      wrapper,
      initialProps: { key: 0 as string | number },
    })
    await waitFor(() => expect(result.current.data?.total_games).toBe(4212))

    let resolve: ((value: unknown) => void) | undefined
    apiGet.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    rerender({ key: 'running' })

    // Mid-flight: the library is still reported, not lost.
    expect(result.current.data?.total_games).toBe(4212)

    resolve?.({ data: { ...SUMMARY, total_games: 4216 } })
    await waitFor(() => expect(result.current.data?.total_games).toBe(4216))
  })

  it('surfaces the error so a real outage can be told from an empty account', async () => {
    apiGet.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useImportSummary('saint_uwe'), { wrapper })
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.data).toBeNull()
  })

  it('does not fetch without a username', () => {
    renderHook(() => useImportSummary(null), { wrapper })
    expect(apiGet).not.toHaveBeenCalled()
  })
})
