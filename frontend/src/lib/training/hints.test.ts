import { describe, expect, it } from 'vite-plus/test'

import { describeHint } from './hints'

// After 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nd4?? — 4.Nxe5 wins a pawn, 4.Bxf7+ is a check.
const AFTER_ND4 = 'r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq -'

describe('describeHint', () => {
  it('names the kind of move first, never the move', () => {
    expect(describeHint(AFTER_ND4, 'f3e5', 1)).toEqual({
      level: 1,
      text: 'A capture.',
      square: null,
    })
    expect(describeHint(AFTER_ND4, 'c4f7', 1)?.text).toBe('A capture with check.')
    expect(describeHint(AFTER_ND4, 'e1g1', 1)?.text).toBe('A king move.')
  })

  it('then points at the piece and the square it stands on', () => {
    expect(describeHint(AFTER_ND4, 'f3e5', 2)).toEqual({
      level: 2,
      text: 'Look at the knight on f3.',
      square: 'f3',
    })
  })

  it('knows a check and a mate', () => {
    // Scholar's mate: 4.Qxf7#.
    const beforeMate = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq -'
    expect(describeHint(beforeMate, 'h5f7', 1)?.text).toBe('It is mate in one.')
    expect(describeHint(beforeMate, 'c4f7', 1)?.text).toBe('A capture with check.')
    expect(describeHint('4k3/8/8/8/8/8/8/4K2R w K -', 'h1h8', 1)?.text).toBe('A check.')
  })

  it('accepts a four-field FEN and refuses an illegal move', () => {
    expect(describeHint('4k3/8/8/8/8/8/8/4K2R w K -', 'h1h7', 1)?.text).toBe('A rook move.')
    expect(describeHint(AFTER_ND4, 'a1a8', 1)).toBeNull()
  })
})
