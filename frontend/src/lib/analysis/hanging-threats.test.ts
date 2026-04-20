import { describe, expect, it } from 'vitest'

import { findHangingPieceThreat } from './hanging-threats'

describe('findHangingPieceThreat', () => {
  it('finds the strongest legal capture of an undefended piece for the side to move', () => {
    expect(findHangingPieceThreat('4r3/8/8/8/4Q3/8/8/4K2k b - - 0 1')).toEqual({
      from: 'e8',
      to: 'e4',
      captured: 'q',
      capturedValue: 9,
    })
  })

  it('does not report defended pieces as hanging threats', () => {
    expect(findHangingPieceThreat('4r3/8/8/8/4Q3/8/5N2/4K2k b - - 0 1')).toBeNull()
  })
})
