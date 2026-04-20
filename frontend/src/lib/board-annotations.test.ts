import { describe, expect, it } from 'vitest'

import { shouldShowBoardAnnotations } from './board-annotations'

describe('shouldShowBoardAnnotations', () => {
  it('hides board annotations during free play even when the engine is enabled', () => {
    expect(
      shouldShowBoardAnnotations({
        hasActiveGame: false,
        hasSelectedOpening: false,
      }),
    ).toBe(false)
  })

  it('shows board annotations for loaded games and selected openings', () => {
    expect(
      shouldShowBoardAnnotations({
        hasActiveGame: true,
        hasSelectedOpening: false,
      }),
    ).toBe(true)

    expect(
      shouldShowBoardAnnotations({
        hasActiveGame: false,
        hasSelectedOpening: true,
      }),
    ).toBe(true)
  })
})
