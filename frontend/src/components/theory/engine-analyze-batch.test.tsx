// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render as renderComponent,
  screen,
  waitFor,
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { api } from '@/lib/api'
import * as engineStore from '@/store/engine-store'
import { EngineAnalyzeBatch } from './engine-analyze-batch'

const KEY = 'chessgod.analysisAutopilot'

function render(component: ReactElement) {
  // These tests exercise batch scheduling, not plan fetching. Provide the real
  // query context without unrelated requests interfering with API assertions.
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, gcTime: 0 } },
  })
  return renderComponent(component, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}

it.each(['pause', 'unmount', 'scope'])(
  'ignores an obsolete batch response after %s',
  async (action) => {
    const originalQueue = engineStore.useEngineStore.getState().queueReplayAnalysis
    const queue = vi.fn().mockResolvedValue(undefined)
    engineStore.useEngineStore.setState({ queueReplayAnalysis: queue, replayQueueActive: false })
    vi.spyOn(api, 'get').mockResolvedValue({ data: { fens: [], missing_count: 2 } })
    let finish!: (value: { data: { fens: string[]; missing_count: number } }) => void
    const pending = new Promise<{ data: { fens: string[]; missing_count: number } }>((resolve) => {
      finish = resolve
    })
    const post = vi
      .spyOn(api, 'post')
      .mockReturnValueOnce(pending)
      .mockImplementation(() => new Promise(() => {}))
    try {
      const { rerender, unmount } = render(
        <EngineAnalyzeBatch username="tester" color="both" timeClass="rapid_blitz" />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Analyze my games' }))
      await waitFor(() => expect(post).toHaveBeenCalledOnce())
      if (action === 'pause')
        fireEvent.click(screen.getByRole('button', { name: 'Pause analysis' }))
      else if (action === 'unmount') unmount()
      else rerender(<EngineAnalyzeBatch username="other" color="both" timeClass="rapid_blitz" />)
      await act(async () => {
        finish({ data: { fens: ['old-position'], missing_count: 1 } })
        await pending
      })
      expect(queue).not.toHaveBeenCalled()
      if (action === 'scope') {
        expect(post).toHaveBeenCalledTimes(2)
        expect(post.mock.calls[1][2]?.params.username).toBe('other')
      }
    } finally {
      cleanup()
      engineStore.useEngineStore.setState({ queueReplayAnalysis: originalQueue })
    }
  },
)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

it.each([['next-position'], []])('requests work beyond session timeouts: %j', async (...fens) => {
  const originalQueue = engineStore.useEngineStore.getState().queueReplayAnalysis
  const queue = vi.fn().mockResolvedValue(undefined)
  engineStore.useEngineStore.setState({ queueReplayAnalysis: queue, replayQueueActive: false })
  vi.spyOn(engineStore, 'getReplayTimedOutFens').mockReturnValue(['timed-out-position'])
  vi.spyOn(engineStore, 'isReplayTimedOutFen').mockImplementation(
    (fen) => fen === 'timed-out-position',
  )
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { fens: ['timed-out-position'], missing_count: 3 },
  })
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { fens, missing_count: 3 } })
  try {
    render(<EngineAnalyzeBatch username="tester" color="both" timeClass="rapid_blitz" />)
    fireEvent.click(screen.getByRole('button', { name: 'Analyze my games' }))
    await waitFor(() => expect(queue).toHaveBeenCalledWith(fens, expect.any(Object)))
    expect(post).toHaveBeenCalledWith(
      '/api/games/unanalyzed-fens',
      {
        exclude_fens: ['timed-out-position'],
      },
      expect.objectContaining({
        params: expect.objectContaining({ username: 'tester', limit: 24 }),
      }),
    )
    expect(screen.queryByText('All positions analyzed.')).toBeNull()
  } finally {
    engineStore.useEngineStore.setState({ queueReplayAnalysis: originalQueue })
  }
})

describe('analysis autopilot preference', () => {
  it('stays off until it is asked for, then survives a reload', async () => {
    const { readAutopilotPreference, writeAutopilotPreference } =
      await import('./autopilot-preference')

    expect(readAutopilotPreference()).toBe(false)

    writeAutopilotPreference(true)
    expect(window.localStorage.getItem(KEY)).toBe('true')
    expect(readAutopilotPreference()).toBe(true)

    writeAutopilotPreference(false)
    expect(readAutopilotPreference()).toBe(false)
  })

  it('falls back to off when the browser refuses storage', async () => {
    const { readAutopilotPreference, writeAutopilotPreference } =
      await import('./autopilot-preference')
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked')
      },
    })

    expect(readAutopilotPreference()).toBe(false)
    expect(() => writeAutopilotPreference(true)).not.toThrow()

    if (original) Object.defineProperty(window, 'localStorage', original)
  })
})

describe('analysis batch phase summary', () => {
  it('describes the actual decision-pair mix in training order', async () => {
    const { formatSelectedPairCounts } = await import('./engine-analyze-batch')

    expect(
      formatSelectedPairCounts({
        endgame: 4,
        middlegame: 4,
        opening: 5,
      }),
    ).toBe('Next up: 4 endgame, 4 middlegame, 5 opening positions.')
    expect(formatSelectedPairCounts({ endgame: 0, middlegame: 0, opening: 0 })).toBeNull()
  })
})

it('stops asking for work this browser cannot take on', async () => {
  // The server lists positions the engine declines — already searched here and
  // waiting to upload, or a finished game an old import never recorded. The
  // old code counted them as queued, so the crawl asked for the same batch
  // every thirty seconds forever and the panel claimed to be analyzing.
  vi.useFakeTimers()
  const originalQueue = engineStore.useEngineStore.getState().queueReplayAnalysis
  const queue = vi.fn().mockResolvedValue(0)
  engineStore.useEngineStore.setState({ queueReplayAnalysis: queue, replayQueueActive: false })
  vi.spyOn(api, 'get').mockResolvedValue({ data: { fens: [], missing_count: 5 } })
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { fens: ['declined-position'], missing_count: 5 } })
  try {
    render(<EngineAnalyzeBatch username="tester" color="both" timeClass="rapid_blitz" />)
    fireEvent.click(screen.getByRole('button', { name: 'Analyze my games' }))

    await vi.waitFor(() => expect(queue).toHaveBeenCalled())
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
    }

    // It gives a pending upload a couple of cycles, then stops.
    expect(post.mock.calls.length).toBeLessThanOrEqual(3)
    expect(screen.getByRole('button', { name: 'Analyze my games' })).toBeTruthy()
    expect(screen.getByText(/Paused while finished analysis uploads/)).toBeTruthy()
  } finally {
    cleanup()
    engineStore.useEngineStore.setState({ queueReplayAnalysis: originalQueue })
    vi.useRealTimers()
  }
})

it('asks the engine for the depth each position needs', async () => {
  const originalQueue = engineStore.useEngineStore.getState().queueReplayAnalysis
  const queue = vi.fn().mockResolvedValue(1)
  engineStore.useEngineStore.setState({ queueReplayAnalysis: queue, replayQueueActive: false })
  vi.spyOn(api, 'get').mockResolvedValue({ data: { fens: [], missing_count: 1 } })
  vi.spyOn(api, 'post').mockResolvedValue({
    data: { fens: ['needs-30'], fen_depths: { 'needs-30': 30 }, missing_count: 1 },
  })
  try {
    render(<EngineAnalyzeBatch username="tester" color="both" timeClass="rapid_blitz" />)
    fireEvent.click(screen.getByRole('button', { name: 'Analyze my games' }))
    await waitFor(() =>
      expect(queue).toHaveBeenCalledWith(
        ['needs-30'],
        expect.objectContaining({ depthByFen: { 'needs-30': 30 } }),
      ),
    )
  } finally {
    cleanup()
    engineStore.useEngineStore.setState({ queueReplayAnalysis: originalQueue })
  }
})

it('shows which phases the engine has actually judged', async () => {
  // The queue can only raise a mistake from a decision that was analysed, so a
  // library judged almost entirely in the opening yields almost entirely
  // opening lessons. Saying so is the difference between "no middlegame
  // weaknesses" and "your middlegame was never examined".
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  vi.spyOn(api, 'get').mockImplementation((url: string) => {
    if (String(url).includes('/api/improvement/plan')) {
      return Promise.resolve({
        data: {
          min_user_rating: 1000,
          summary: {
            analyzed_decisions: 3641,
            total_decisions: 93945,
            analyzed_by_phase: [
              { phase: 'opening', analyzed_decisions: 3575, share: 0.982 },
              { phase: 'middlegame', analyzed_decisions: 26, share: 0.007 },
              { phase: 'endgame', analyzed_decisions: 40, share: 0.011 },
            ],
            patterns: [],
            due_positions: 0,
          },
          drills: [],
        },
      })
    }
    return Promise.resolve({
      data: { fens: [], candidate_count: 179313, analyzed_count: 1165, missing_count: 178148 },
    })
  })
  try {
    renderComponent(<EngineAnalyzeBatch username="tester" color="both" timeClass="rapid_blitz" />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    await waitFor(() => expect(screen.getByText('3,575')).toBeTruthy())
    // Counts a person reads as a quantity are formatted.
    expect(screen.getByText('3,641 of 93,945')).toBeTruthy()
    expect(screen.getByText('26')).toBeTruthy()
    expect(screen.getByText(/middlegame and endgame play has barely been analyzed/)).toBeTruthy()
    expect(screen.getByText(/doesn't mean it has no mistakes/)).toBeTruthy()
  } finally {
    cleanup()
  }
})

it('reports a failed phase-coverage request instead of showing an empty breakdown', async () => {
  // A request that failed is not a library with nothing in it. Drawing zeroed
  // bars here would state a fact about the player's chess that is not known.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  vi.spyOn(api, 'get').mockImplementation((url: string) => {
    if (String(url).includes('/api/improvement/plan')) {
      return Promise.reject(new Error('offline'))
    }
    return Promise.resolve({ data: { fens: [], missing_count: 0 } })
  })
  try {
    renderComponent(<EngineAnalyzeBatch username="tester" color="both" timeClass="rapid_blitz" />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByText(/Could not load phase coverage/)).toBeTruthy()
    expect(screen.queryByText('Judged decisions by phase')).toBeNull()
  } finally {
    cleanup()
  }
})
