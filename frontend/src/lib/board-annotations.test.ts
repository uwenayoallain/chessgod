import { describe, expect, it } from 'vite-plus/test'

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

  it('hides board annotations while a drill is waiting for the move', () => {
    expect(
      shouldShowBoardAnnotations({
        hasActiveGame: true,
        hasSelectedOpening: true,
        isSolvingDrill: true,
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
