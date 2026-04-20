import { describe, expect, it } from 'vitest'

import { parsePgnToReplay } from './chess-utils'

describe('parsePgnToReplay', () => {
  it('includes the played uci for each replay move', () => {
    const replay = parsePgnToReplay('1. e4 e5 2. Nf3 Nc6')

    expect(replay).toEqual([
      {
        ply: 1,
        san: 'e4',
        uci: 'e2e4',
        fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -',
      },
      {
        ply: 2,
        san: 'e5',
        uci: 'e7e5',
        fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -',
      },
      {
        ply: 3,
        san: 'Nf3',
        uci: 'g1f3',
        fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -',
      },
      {
        ply: 4,
        san: 'Nc6',
        uci: 'b8c6',
        fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -',
      },
    ])
  })
})
