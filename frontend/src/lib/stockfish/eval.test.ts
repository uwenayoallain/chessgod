import { describe, expect, it } from 'vitest'

import { scoreToWhitePerspective } from './eval'

describe('scoreToWhitePerspective', () => {
  it('keeps the score when white is to move', () => {
    expect(
      scoreToWhitePerspective(
        { type: 'cp', value: 42 },
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
      ),
    ).toEqual({ type: 'cp', value: 42 })
  })

  it('flips the score when black is to move', () => {
    expect(
      scoreToWhitePerspective(
        { type: 'cp', value: 42 },
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq -',
      ),
    ).toEqual({ type: 'cp', value: -42 })
  })

  it('flips mate scores when black is to move', () => {
    expect(
      scoreToWhitePerspective(
        { type: 'mate', value: 3 },
        '8/8/8/8/8/8/8/8 b - -',
      ),
    ).toEqual({ type: 'mate', value: -3 })
  })
})
