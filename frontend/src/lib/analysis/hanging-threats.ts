import { Chess, type Color, type PieceSymbol } from 'chess.js'

const PIECE_VALUES: Record<PieceSymbol, number> = {
  b: 3,
  k: 0,
  n: 3,
  p: 1,
  q: 9,
  r: 5,
}

export type HangingPieceThreat = {
  from: string
  to: string
  captured: PieceSymbol
  capturedValue: number
}

function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w'
}

function withOppositeTurn(fen: string): string | null {
  const parts = fen.trim().split(/\s+/)
  if (parts.length < 2 || (parts[1] !== 'w' && parts[1] !== 'b')) {
    return null
  }
  parts[1] = opposite(parts[1] as Color)
  return parts.join(' ')
}

export function findHangingPieceThreat(fen: string): HangingPieceThreat | null {
  let chess: Chess
  try {
    chess = new Chess(fen)
  } catch {
    return null
  }

  const defender = opposite(chess.turn())
  const captures = chess
    .moves({ verbose: true })
    .filter((move) => move.captured && !chess.isAttacked(move.to, defender))
    .map((move) => ({
      captured: move.captured!,
      capturedValue: PIECE_VALUES[move.captured!],
      from: move.from,
      to: move.to,
    }))
    .sort((a, b) => b.capturedValue - a.capturedValue)

  return captures[0] ?? null
}

export function findOpponentHangingPieceThreat(fen: string): HangingPieceThreat | null {
  const opponentFen = withOppositeTurn(fen)
  return opponentFen ? findHangingPieceThreat(opponentFen) : null
}
