import { Chess, type Square } from 'chess.js'

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
