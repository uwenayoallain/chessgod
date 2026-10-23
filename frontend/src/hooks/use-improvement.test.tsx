// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { AxiosError } from 'axios'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vite-plus/test'

import { api } from '@/lib/api'
import { useImprovementPlan, type ImprovementPlan } from './use-improvement'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('refreshes the active plan without delaying the saved grade', async () => {
  const saved = {
    correct: true,
    follow_up_correct: null,
    intent_matched: null,
    intent_feedback: null,
  }
  const refreshed = { summary: { attempts: 1 } }
  let completeRefresh!: (value: { data: typeof refreshed }) => void
  const refresh = new Promise<{ data: typeof refreshed }>((resolve) => {
    completeRefresh = resolve
  })
  const get = vi.spyOn(api, 'get').mockImplementation(() => refresh)
  vi.spyOn(api, 'post').mockResolvedValue({ data: saved })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['improvement-plan', 'tester', 'both', 'rapid_blitz', null], {
    summary: { attempts: 0 },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(
    () => useImprovementPlan({ username: 'tester', color: 'both', timeClass: 'rapid_blitz' }),
    { wrapper },
  )
  try {
    await act(async () => {
      expect(
        await result.current.attempt.mutateAsync({
          request_id: '853d8200-3859-4229-b164-7619a6bd00fe',
          username: 'tester',
          position_id: 1,
          expected_move_uci: 'e2e4',
          played_move_uci: 'e2e4',
          pattern_key: 'calculation',
          response_ms: 500,
        }),
      ).toEqual(saved)
    })
    expect(get).toHaveBeenCalledOnce()
    await waitFor(() => expect(result.current.isFetching).toBe(true))
    await act(async () => {
      completeRefresh({ data: refreshed })
      await refresh
    })
    await waitFor(() => expect(result.current.data?.summary.attempts).toBe(1))
  } finally {
    client.clear()
  }
})

it.each([false, true])(
  'refreshes only the answer owner after saving, unmounted: %s',
  async (unmounted) => {
    const saved = {
      correct: true,
      follow_up_correct: null,
      intent_matched: null,
      intent_feedback: null,
    }
    let completeSave!: (value: { data: typeof saved }) => void
    const save = new Promise<{ data: typeof saved }>((resolve) => {
      completeSave = resolve
    })
    vi.spyOn(api, 'post').mockImplementation(() => save)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const ownerKey = ['improvement-plan', 'tester', 'both', 'rapid_blitz', null]
    const themeKey = ['improvement-plan', 'tester', 'black', 'rapid', 'fork']
    const otherKey = ['improvement-plan', 'other', 'both', 'rapid_blitz', null]
    for (const key of [ownerKey, themeKey, otherKey]) client.setQueryData(key, { cached: true })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result, unmount } = renderHook(
      () =>
        useImprovementPlan({
          username: 'tester',
          color: 'both',
          timeClass: 'rapid_blitz',
          enabled: false,
        }),
      { wrapper },
    )
    try {
      const submission = result.current.attempt.mutateAsync({
        request_id: '853d8200-3859-4229-b164-7619a6bd00fe',
        username: 'tester',
        position_id: 1,
        expected_move_uci: 'e2e4',
        played_move_uci: 'e2e4',
        pattern_key: 'calculation',
        response_ms: 500,
      })
      if (unmounted) unmount()
      await act(async () => {
        completeSave({ data: saved })
        await submission
      })
      expect(client.getQueryState(ownerKey)?.isInvalidated).toBe(true)
      expect(client.getQueryState(themeKey)?.isInvalidated).toBe(true)
      expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false)
    } finally {
      client.clear()
    }
  },
)

it.each([
  [{ username: 'other' }, false],
  [{ color: 'black' as const }, false],
  [{ timeClass: 'rapid' }, false],
  [{ patternKey: 'fork' }, true],
] as const)('retains placeholder lessons only within the same scope: %j', (change, retain) => {
  vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => {}))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const original = {
    username: 'tester',
    color: 'both',
    time_class: 'rapid_blitz',
    drills: [],
  } as unknown as ImprovementPlan
  client.setQueryData(['improvement-plan', 'tester', 'both', 'rapid_blitz', null], original)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  type Scope = Parameters<typeof useImprovementPlan>[0]
  const initialProps: Scope = {
    username: 'tester',
    color: 'both',
    timeClass: 'rapid_blitz',
    patternKey: null,
  }
  const { result, rerender } = renderHook((props: Scope) => useImprovementPlan(props), {
    initialProps,
    wrapper,
  })
  try {
    expect(result.current.data).toBe(original)
    rerender({ ...initialProps, ...change })
    expect(result.current.data).toBe(retain ? original : undefined)
    expect(result.current.isPlaceholderData).toBe(retain)
  } finally {
    client.clear()
  }
})

it.each([undefined, 503, 409, 422])('retries only transient answer errors: %s', async (status) => {
  const failure = new AxiosError('Request failed')
  if (status) failure.response = { status } as AxiosError['response']
  const saved = {
    correct: true,
    follow_up_correct: null,
    intent_matched: null,
    intent_feedback: null,
  }
  const post = vi
    .spyOn(api, 'post')
    .mockRejectedValueOnce(failure)
    .mockResolvedValue({ data: saved })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(
    () =>
      useImprovementPlan({
        username: 'tester',
        color: 'both',
        timeClass: 'rapid_blitz',
        enabled: false,
      }),
    { wrapper },
  )
  const payload = {
    request_id: '853d8200-3859-4229-b164-7619a6bd00fe',
    username: 'tester',
    position_id: 1,
    expected_move_uci: 'e2e4',
    played_move_uci: 'e2e4',
    pattern_key: 'calculation',
    response_ms: 500,
  }
  const transient = status == null || status >= 500
  try {
    await act(async () => {
      const submit = result.current.attempt.mutateAsync(payload)
      if (transient) expect(await submit).toEqual(saved)
      else await expect(submit).rejects.toBe(failure)
    })
    expect(post).toHaveBeenCalledTimes(transient ? 2 : 1)
    for (const call of post.mock.calls) {
      // The same answer on every retry, with the player's day for the quests.
      expect(call).toEqual([
        '/api/improvement/attempts',
        { ...payload, tz: expect.any(String) },
        { timeout: 15_000 },
      ])
    }
  } finally {
    client.clear()
  }
})
