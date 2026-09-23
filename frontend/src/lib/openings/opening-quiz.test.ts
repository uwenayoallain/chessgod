import { describe, expect, it } from 'vite-plus/test'

import { describeUsualMove, gradeQuizMove, type OpeningQuizPosition } from './opening-quiz'

const sicilian: OpeningQuizPosition = {
  position_id: 3,
  fen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -',
  ply: 2,
  side_to_move: 'white',
  occurrences: 86,
  opening_name: 'Sicilian Defense',
  last_move_uci: 'c7c5',
  user_moves: [
    { uci: 'f1c4', san: 'Bc4', count: 61, share: 0.71 },
    { uci: 'g1f3', san: 'Nf3', count: 25, share: 0.29 },
  ],
  book_moves: [
    { uci: 'g1f3', san: 'Nf3', count: 800, share: 0.8 },
    { uci: 'b1c3', san: 'Nc3', count: 180, share: 0.18 },
  ],
  usual_move_in_book: false,
}

describe('gradeQuizMove', () => {
  it('tells the main line from the rest of the book, and both from a move off it', () => {
    expect(gradeQuizMove(sicilian, 'g1f3')).toEqual({
      kind: 'main',
      headline: 'Nf3 is the main line — 80% of master games.',
      share: 0.8,
    })
    expect(gradeQuizMove(sicilian, 'b1c3').kind).toBe('book')
    expect(gradeQuizMove(sicilian, 'b1c3').headline).toContain('The main line is Nf3')
    expect(gradeQuizMove(sicilian, 'f1c4')).toEqual({
      kind: 'off-book',
      headline: 'Off book — masters play Nf3 here (80%), and this move in under 3% of games, if ever.',
      share: null,
    })
  })

  it('says what the player usually does, and whether masters agree', () => {
    expect(describeUsualMove(sicilian)).toBe(
      'You usually play Bc4 here (61 of 86 games), which masters rarely play.',
    )
    expect(describeUsualMove({ ...sicilian, usual_move_in_book: true })).toContain('that is book')
  })
})
