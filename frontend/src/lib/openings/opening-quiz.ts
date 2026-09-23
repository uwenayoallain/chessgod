export type QuizMove = { uci: string; san: string; count: number; share: number }

export type OpeningQuizPosition = {
  position_id: number
  fen: string
  ply: number
  side_to_move: 'white' | 'black'
  occurrences: number
  opening_name: string | null
  last_move_uci: string | null
  user_moves: QuizMove[]
  book_moves: QuizMove[]
  usual_move_in_book: boolean
}

export type QuizVerdict = {
  kind: 'main' | 'book' | 'off-book'
  /** What the answer was, in words. */
  headline: string
  /** The master share of the move played; null off book. */
  share: number | null
}

function percent(share: number) {
  return `${Math.round(share * 100)}%`
}

/**
 * Grade an answer against the master book: the most-played master move is
 * the main line, any other book move is book, and anything else is off book.
 * "Book" here is the server's threshold (≥3% of master games, ≥10 games), so a
 * move a handful of masters tried once is not passed off as theory.
 */
export function gradeQuizMove(position: OpeningQuizPosition, uci: string): QuizVerdict {
  const index = position.book_moves.findIndex((move) => move.uci === uci)
  if (index === 0) {
    const move = position.book_moves[0]
    return {
      kind: 'main',
      headline: `${move.san} is the main line — ${percent(move.share)} of master games.`,
      share: move.share,
    }
  }
  if (index > 0) {
    const move = position.book_moves[index]
    return {
      kind: 'book',
      headline: `${move.san} is book — ${percent(move.share)} of master games. The main line is ${position.book_moves[0].san}.`,
      share: move.share,
    }
  }
  const main = position.book_moves[0]
  return {
    kind: 'off-book',
    headline: `Off book — masters play ${main.san} here (${percent(main.share)}), and this move in under 3% of games, if ever.`,
    share: null,
  }
}

/** What the player has actually played here, and whether it is book. */
export function describeUsualMove(position: OpeningQuizPosition) {
  const usual = position.user_moves[0]
  if (!usual) return null
  const times = `${usual.count.toLocaleString()} of ${position.occurrences.toLocaleString()} games`
  return position.usual_move_in_book
    ? `You usually play ${usual.san} here (${times}) — that is book.`
    : `You usually play ${usual.san} here (${times}), which masters rarely play.`
}

export function formatShare(share: number) {
  return percent(share)
}
