import { Chess, type Square } from 'chess.js'

import { memoize } from './memo'

export type ReplayStep = {
  ply: number
  san: string
  uci: string
  fen: string
}

export function computeLegalDests(chess: Chess) {
  const dests = new Map<Square, Square[]>()

  for (const rank of chess.board()) {
    for (const piece of rank) {
      if (!piece) {
        continue
      }
      const moves = chess.moves({ square: piece.square, verbose: true }).map((move) => move.to)
      if (moves.length) {
        dests.set(piece.square, moves)
      }
    }
  }

  return dests
}

export function normalizeFrontendFen(fen: string) {
  return fen.split(' ').slice(0, 4).join(' ')
}

export function parsePgnToReplay(pgn: string): ReplayStep[] {
  const parsed = new Chess()
  parsed.loadPgn(pgn)

  const history = parsed.history({ verbose: true }) as Array<{
    san: string
    from: string
    to: string
    promotion?: string
  }>
  const replay = new Chess()

  return history.map((move, index) => {
    replay.move(move.san)
    return {
      ply: index + 1,
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ''}`,
      fen: normalizeFrontendFen(replay.fen()),
    }
  })
}

/**
 * A UCI move as a player writes it (`e7e5` -> `e5`). Falls back to the UCI
 * string when the move does not play on `fen`, so a stale line still reads.
 */
/**
 * A SAN move as the board draws it (`Nf3` -> `g1f3`). Null when the move does
 * not play on `fen`, so a caller can simply draw nothing for stale data.
 */
export const sanToUci = memoize(function sanToUci(fen: string, san: string): string | null {
  try {
    const parts = fen.trim().split(/\s+/)
    while (parts.length < 6) parts.push(parts.length === 4 ? '0' : '1')
    const move = new Chess(parts.join(' ')).move(san)
    return move ? move.from + move.to + (move.promotion ?? '') : null
  } catch {
    return null
  }
})

export const uciToSan = memoize(function uciToSan(fen: string, uci: string): string {
  try {
    const parts = fen.trim().split(/\s+/)
    while (parts.length < 6) parts.push(parts.length === 4 ? '0' : '1')
    const move = new Chess(parts.join(' ')).move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    })
    return move?.san ?? uci
  } catch {
    return uci
  }
})
