export type PvMoveAction = {
  fen: string
  san: string
  uci: string
}

export function getPvPrefixToMove(moves: PvMoveAction[], index: number): PvMoveAction[] {
  if (index < 0 || index >= moves.length) return []
  return moves.slice(0, index + 1)
}
