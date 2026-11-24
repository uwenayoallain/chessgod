// @vitest-environment jsdom

import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { TrainingProfile } from '@/lib/training/types'

import { TrainingChip, useStreakRisk } from './training-widgets'

const { profileState } = vi.hoisted(() => ({
  profileState: { current: undefined as unknown },
}))

vi.mock('@/hooks/use-training', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-training')>()),
  useTrainingProfile: () => ({ data: profileState.current }),
}))

function profile(extra: Partial<TrainingProfile> = {}): TrainingProfile {
  return {
    username: 'tester',
    xp: 400,
    level: 3,
    title: 'Knight',
    level_floor_xp: 300,
    next_level_xp: 600,
    daily_goal: 30,
    today_xp: 0,
    goal_met_today: false,
    streak: 4,
    best_streak: 9,
    freezes: 0,
    freeze_every_xp: 250,
    week: [],
    rival: { this_week: 0, last_week_so_far: 0, last_week: 0 },
    rush_best: 0,
    threats_spotted: 0,
    threats_seen: 0,
    due_repertoire_moves: 0,
    due_drills: 0,
    quests: { date: '2026-11-24', items: [], all_done: false, chest_xp: 20, chest_opened: false },
    achievements: [],
    ...extra,
  }
}

/** Local wall-clock time, since the risk hour is the player's own evening. */
function at(hours: number, minutes: number, seconds = 0) {
  vi.setSystemTime(new Date(2026, 10, 24, hours, minutes, seconds))
}

describe('useStreakRisk', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('counts down on the minute without any other render', () => {
    at(21, 30, 20)
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useStreakRisk(profile())
    })
    // 21:30:20 rounds to 150 minutes before midnight.
    expect(result.current).toBe(150)
    const drawn = renders

    // Nothing redraws inside the minute.
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(renders).toBe(drawn)

    act(() => {
      vi.advanceTimersByTime(10_500)
    })
    expect(result.current).toBe(149)

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(result.current).toBe(148)
    expect(renders).toBe(drawn + 2)
  })

  it('starts as the evening does, and costs no render before it', () => {
    at(17, 57, 40)
    let renders = 0
    const stable = profile()
    const { result } = renderHook(() => {
      renders += 1
      return useStreakRisk(stable)
    })
    expect(result.current).toBeNull()

    act(() => {
      vi.advanceTimersByTime(2 * 60_000)
    })
    // 17:59:40, still the afternoon: two ticks have passed and drawn nothing.
    expect(result.current).toBeNull()
    expect(renders).toBe(1)

    act(() => {
      vi.advanceTimersByTime(21_000)
    })
    // 18:00:01, caught on the boundary rather than a minute late.
    expect(result.current).toBe(360)
    expect(renders).toBe(2)
  })

  it('checks at once when the tab comes back, without waiting for the timer', () => {
    at(17, 59, 30)
    const stable = profile()
    const { result } = renderHook(() => useStreakRisk(stable))
    expect(result.current).toBeNull()

    // A laptop asleep through the boundary: the clock moved, the timer did not.
    at(19, 14, 10)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(result.current).toBe(286)
  })

  it('sets no timer when the streak cannot be at risk', () => {
    at(21, 0)
    renderHook(() => useStreakRisk(profile({ goal_met_today: true })))
    renderHook(() => useStreakRisk(profile({ streak: 0 })))
    renderHook(() => useStreakRisk(undefined))

    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears its timer and listener on unmount', () => {
    at(21, 0)
    const removed = vi.spyOn(document, 'removeEventListener')
    const { unmount } = renderHook(() => useStreakRisk(profile()))
    expect(vi.getTimerCount()).toBe(1)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
    expect(removed).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    removed.mockRestore()
  })
})

describe('TrainingChip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('starts warning in a tab left open across 18:00', () => {
    at(17, 59, 50)
    profileState.current = profile()
    const { container } = render(<TrainingChip username="tester" />)
    const chip = container.querySelector('.training-chip')!
    expect(chip.hasAttribute('data-risk')).toBe(false)

    act(() => {
      vi.advanceTimersByTime(11_000)
    })

    expect(chip.hasAttribute('data-risk')).toBe(true)
  })
})
