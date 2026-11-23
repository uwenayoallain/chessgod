import { Chess } from 'chess.js'

import { scoreToWhitePerspective } from '@/lib/stockfish/eval'
import type { UCIInfo } from '@/lib/stockfish/uci'

export type ContinuationMove = {
  san: string
  uci: string
  /** The board after this move, so a reader can jump onto any ply of the line. */
  fen: string
  /** Whose move it was, from the side that was to move in the root position. */
  side: 'player' | 'opponent'
}

export type Continuation = {
  moves: ContinuationMove[]
  /** Evaluation from the side to move in the root position. */
  scoreCp: number | null
  mateIn: number | null
  depth: number
}

function toFullFen(fen: string): string {
  const parts = fen.trim().split(/\s+/)
  while (parts.length < 6) parts.push(parts.length === 4 ? '0' : '1')
  return parts.join(' ')
}

/**
 * Turn a principal variation into playable moves.
 *
 * Stops at the first move that will not play rather than throwing: a PV can
 * outlive the position it was searched from, and half a line is still worth
 * reading.
 */
export function pvToMoves(rootFen: string, pv: string[]): ContinuationMove[] {
  const moves: ContinuationMove[] = []
  try {
    const board = new Chess(toFullFen(rootFen))
    const moverIsWhite = board.turn() === 'w'
    for (const uci of pv) {
      const move = board.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
      })
      if (!move) break
      moves.push({
        san: move.san,
        uci,
        fen: board.fen().split(' ').slice(0, 4).join(' '),
        side: (move.color === 'w') === moverIsWhite ? 'player' : 'opponent',
      })
    }
  } catch {
    // An illegal or stale PV yields whatever converted before it broke.
  }
  return moves
}

/**
 * What the engine says happens next, from the side that has to move.
 *
 * A finished drill tells the reader which move was right and why it was right,
 * and then stops — leaving the question the position actually raises ("and then
 * what?") unanswered. This is the engine's own line from the drill position, so
 * the answer comes from a search rather than from the card's stored text.
 */
export function buildContinuation({
  rootFen,
  line,
  maxPlies = 6,
}: {
  rootFen: string
  line: UCIInfo | null | undefined
  maxPlies?: number
}): Continuation | null {
  if (!line?.pv?.length || !rootFen) return null

  const moves = pvToMoves(rootFen, line.pv).slice(0, maxPlies)
  if (!moves.length) return null

  const white = scoreToWhitePerspective(line.score, rootFen)
  // Read it from the side to move, which is the person doing the drill.
  const blackToMove = toFullFen(rootFen).split(' ')[1] === 'b'
  const signed = blackToMove ? -white.value : white.value

  return {
    moves,
    scoreCp: white.type === 'cp' ? signed : null,
    mateIn: white.type === 'mate' ? signed : null,
    depth: line.depth,
  }
}

/** "+1.4", "−0.3", "M3" — the evaluation as the drill's side reads it. */
export function formatContinuationScore(continuation: Continuation): string {
  if (continuation.mateIn != null) {
    return `${continuation.mateIn > 0 ? 'M' : '−M'}${Math.abs(continuation.mateIn)}`
  }
  if (continuation.scoreCp == null) return '—'
  const pawns = continuation.scoreCp / 100
  const sign = pawns > 0 ? '+' : pawns < 0 ? '−' : ''
  return `${sign}${Math.abs(pawns).toFixed(1)}`
}
