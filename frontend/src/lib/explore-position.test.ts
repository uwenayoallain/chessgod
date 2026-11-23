// @vitest-environment jsdom

import { expect, it, vi } from 'vite-plus/test'

import { useAppStore } from '@/store/app-store'
import { explorePosition, OPEN_EXPLORE_EVENT } from './explore-position'

it('drops the question and asks for the Engine page', () => {
  useAppStore.setState({ drillSolving: true, hintSquare: 'e5', hintSquareFen: 'x' })
  useAppStore.getState().setTrainerArrows([{ startSquare: 'e2', endSquare: 'e4', color: 'red' }])
  const seen = vi.fn()
  window.addEventListener(OPEN_EXPLORE_EVENT, (event) => seen((event as CustomEvent).detail))
  explorePosition()
  const state = useAppStore.getState()
  expect(state.drillSolving).toBe(false)
  expect(state.hintSquare).toBeNull()
  expect(state.trainerArrows).toEqual([])
  expect(seen).toHaveBeenCalledWith({ section: 'explore-engine' })
})
