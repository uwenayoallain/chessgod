// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { useMistakes } from './use-mistakes'

const { apiGet } = vi.hoisted(() => ({
  apiGet: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: apiGet,
  },
}))

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useMistakes', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not fetch when disabled', () => {
    renderHook(() => useMistakes({ username: 'tester', color: 'both', enabled: false }), {
      wrapper,
    })

    expect(apiGet).not.toHaveBeenCalled()
  })

  it('fetches when enabled', async () => {
    apiGet.mockResolvedValue({ data: [] })

    renderHook(() => useMistakes({ username: 'tester', color: 'both', enabled: true }), { wrapper })

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith('/api/theory/mistakes', expect.any(Object)),
    )
  })
})
