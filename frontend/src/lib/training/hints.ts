import { Chess } from 'chess.js'

/**
 * A graded hint toward a move the player cannot see, without giving it away.
 *
 * Level 1 says what kind of move it is — a capture, a check, a knight move —
 * which is the scan the trainers teach (checks and captures first). Level 2
 * points at the piece: the origin square is highlighted on the board and
 * named. The move itself is never a hint; every trainer has its own way of
 * giving up ("Show me"), and that is scored as a miss.
 */
export type Hint = {
  level: 1 | 2
  text: string
  /** The origin square to highlight on the board (level 2 only). */
  square: string | null
}

export const HINT_LEVELS = 2

const PIECE_NAMES: Record<string, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
}

function fullFen(fen: string) {
  return fen.split(' ').length >= 6 ? fen : `${fen} 0 1`
}

/** The cue for a move, from the board it is played on. */
export function describeHint(fen: string, uci: string, level: 1 | 2): Hint | null {
  const board = new Chess(fullFen(fen))
  const from = uci.slice(0, 2)
  let move: ReturnType<Chess['move']>
  try {
    move = board.move({ from, to: uci.slice(2, 4), promotion: uci.slice(4) || undefined })
  } catch {
    return null
  }
  const piece = PIECE_NAMES[move.piece] ?? 'piece'
  if (level === 2) {
    return { level: 2, text: `Look at the ${piece} on ${from}.`, square: from }
  }
  const mate = move.san.includes('#')
  const check = move.san.includes('+')
  const capture = move.san.includes('x')
  const text = mate
    ? 'It is mate in one.'
    : capture && check
      ? 'A capture with check.'
      : capture
        ? 'A capture.'
        : check
          ? 'A check.'
          : `A ${piece} move.`
  return { level: 1, text, square: null }
}
