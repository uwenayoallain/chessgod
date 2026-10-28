// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vite-plus/test'

import { useAppStore } from '@/store/app-store'
import { useHint, type HintSource } from './use-hint'

const FEN = 'r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq -'

afterEach(() => useAppStore.getState().setHintSquare(null))

it('grades a local hint: the kind of move, then the piece on the board', () => {
  const { result } = renderHook(() => useHint({ fen: FEN, uci: 'f3e5' }, 'q1'))
  expect(result.current.level).toBe(0)
  act(() => result.current.ask())
  expect(result.current.hint?.text).toBe('A capture.')
  expect(useAppStore.getState().hintSquare).toBeNull()
  act(() => result.current.ask())
  expect(result.current.hint?.text).toBe('Look at the knight on f3.')
  expect(result.current.more).toBe(false)
  expect(useAppStore.getState().hintSquare).toBe('f3')
  // No third level.
  act(() => result.current.ask())
  expect(result.current.level).toBe(2)
})

it('keeps a fetched hint even though the source is rebuilt on every render', async () => {
  // Components pass a fresh object literal each render, as Blunder Check does;
  // the hint has to be matched to its question, not to the object that asked.
  const fetch = vi.fn(async (level: 1 | 2) =>
    level === 1
      ? { level, text: 'A check.', square: null }
      : { level, text: 'Look at the bishop on c4.', square: 'c4' },
  )
  const { result, rerender } = renderHook(
    ({ key }: { key: string }) => useHint({ fen: FEN, fetch } as HintSource, key),
    { initialProps: { key: 'q1' } },
  )
  await act(async () => {
    result.current.ask()
    rerender({ key: 'q1' })
  })
  expect(result.current.hint?.text).toBe('A check.')
  expect(result.current.pending).toBe(false)
  await act(async () => result.current.ask())
  expect(result.current.hint?.square).toBe('c4')
  expect(useAppStore.getState().hintSquare).toBe('c4')

  // The next question starts clean, and the ring is gone.
  rerender({ key: 'q2' })
  expect(result.current.level).toBe(0)
  expect(result.current.hint).toBeNull()
  expect(useAppStore.getState().hintSquare).toBeNull()
})

it('drops a hint that arrives after the question has moved on', async () => {
  let resolve: (hint: { level: 1; text: string; square: null }) => void = () => {}
  const fetch = vi.fn(
    () => new Promise<{ level: 1; text: string; square: null }>((r) => (resolve = r)),
  )
  const { result, rerender } = renderHook(
    ({ key }: { key: string }) => useHint({ fen: FEN, fetch } as HintSource, key),
    { initialProps: { key: 'q1' } },
  )
  act(() => result.current.ask())
  rerender({ key: 'q2' })
  await act(async () => resolve({ level: 1, text: 'A check.', square: null }))
  expect(result.current.hint).toBeNull()
  expect(result.current.level).toBe(0)
})
