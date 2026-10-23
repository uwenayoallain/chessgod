import { expect, it } from 'vite-plus/test'

import { recommendedTheme } from './recommended'

const themes = [
  { key: 'mate_allowed', due_positions: 283 },
  { key: 'mate_missed', due_positions: 111 },
  { key: 'fork', due_positions: 0 },
]

it('recommends the first theme with positions ready', () => {
  expect(recommendedTheme(themes, null)).toBe('mate_allowed')
})

it('moves on from the theme just trained today', () => {
  expect(recommendedTheme(themes, 'mate_allowed')).toBe('mate_missed')
})

it('falls back to the trained theme when it is the only one ready, then to any theme', () => {
  expect(recommendedTheme(themes.slice(0, 1), 'mate_allowed')).toBe('mate_allowed')
  expect(recommendedTheme([themes[2]], null)).toBe('fork')
  expect(recommendedTheme([], null)).toBeNull()
})
