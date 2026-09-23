import { describe, expect, it } from 'vite-plus/test'

import { buildBookMarkers, bookMarkerTitle } from './book-markers'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

const move = (san: string, uci: string, game_count: number) => ({
  san,
  uci,
  game_count,
  win_rate: 0.32,
})

describe('buildBookMarkers', () => {
  it('marks the destination square of the most played master moves', () => {
    const markers = buildBookMarkers({
      fen: START,
      masterMoves: [move('e4', 'e2e4', 1_309_466), move('d4', 'd2d4', 1_029_878)],
    })

    expect(Object.keys(markers).sort()).toEqual(['d4', 'e4'])
    expect(markers.e4.rank).toBe(1)
    expect(markers.d4.rank).toBe(2)
  })

  it('ranks by games played, not by the order the API happened to return', () => {
    const markers = buildBookMarkers({
      fen: START,
      masterMoves: [move('d4', 'd2d4', 10), move('e4', 'e2e4', 90)],
    })

    expect(markers.e4.rank).toBe(1)
    expect(markers.d4.rank).toBe(2)
  })

  it('takes the share from every master game, not only the drawn ones', () => {
    // Re-normalising over the top two would make e4 look like 90% of the book.
    const markers = buildBookMarkers({
      fen: START,
      limit: 2,
      masterMoves: [move('e4', 'e2e4', 45), move('d4', 'd2d4', 5), move('Nf3', 'g1f3', 50)],
    })

    expect(Object.keys(markers).sort()).toEqual(['e4', 'f3'])
    expect(markers.e4.share).toBeCloseTo(0.45)
  })

  it('never draws a move that is not legal in this position', () => {
    // Master data is keyed by FEN; a mismatch must not paint a phantom move.
    const markers = buildBookMarkers({
      fen: START,
      masterMoves: [move('e5', 'e7e5', 999)],
    })

    expect(markers).toEqual({})
  })

  it('keeps the more popular move when two land on the same square', () => {
    const markers = buildBookMarkers({
      fen: 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      masterMoves: [move('exd5', 'e4d5', 500), move('Nc3', 'b1c3', 100)],
    })

    expect(markers.d5.san).toBe('exd5')
    expect(markers.d5.rank).toBe(1)
  })

  it('returns nothing rather than dividing by zero when the book is empty', () => {
    expect(buildBookMarkers({ fen: START, masterMoves: [] })).toEqual({})
    expect(buildBookMarkers({ fen: START, masterMoves: null })).toEqual({})
    expect(buildBookMarkers({ fen: '', masterMoves: [move('e4', 'e2e4', 5)] })).toEqual({})
    expect(buildBookMarkers({ fen: START, masterMoves: [move('e4', 'e2e4', 0)] })).toEqual({})
  })

  it('describes what the marker means', () => {
    const markers = buildBookMarkers({
      fen: START,
      masterMoves: [move('e4', 'e2e4', 48), move('d4', 'd2d4', 52)],
    })

    expect(bookMarkerTitle(markers.e4)).toBe('e4 — 48% of master games (48)')
  })
})
