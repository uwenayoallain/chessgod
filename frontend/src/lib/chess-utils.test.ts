import { describe, expect, it } from 'vite-plus/test'

import { parsePgnToReplay, uciToSan } from './chess-utils'

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

describe('uciToSan', () => {
  it('writes an engine move the way a player reads it', () => {
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
    expect(uciToSan(afterE4, 'e7e5')).toBe('e5')
    expect(uciToSan(afterE4, 'g8f6')).toBe('Nf6')
    expect(uciToSan('8/P6k/8/8/8/8/8/K7 w - -', 'a7a8q')).toBe('a8=Q')
    // A move that does not play here is shown as it came, not dropped.
    expect(uciToSan(afterE4, 'e2e4')).toBe('e2e4')
  })
})
