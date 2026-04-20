import { Chess, type Square } from 'chess.js'

import type { UCIInfo } from './uci'

function toFullFen(fen: string): string {
  const parts = fen.split(' ')
  while (parts.length < 6) parts.push(parts.length === 4 ? '0' : '1')
  return parts.join(' ')
}

export function isLegalEngineMove(fen: string, uci: string | null | undefined): boolean {
  if (!uci || uci.length < 4) return false

  try {
    const chess = new Chess(toFullFen(fen))
    const from = uci.slice(0, 2) as Square
    const to = uci.slice(2, 4)
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined
    return chess
      .moves({ square: from, verbose: true })
      .some((move) => move.to === to && (!promotion || move.promotion === promotion))
  } catch {
    return false
  }
}

export function isLegalEngineLine(fen: string, line: UCIInfo): boolean {
  if (!line.pv.length) return false

  try {
    const chess = new Chess(toFullFen(fen))
    for (const uci of line.pv) {
      const from = uci.slice(0, 2)
      const to = uci.slice(2, 4)
      const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined
      const move = chess.move({ from, to, promotion })
      if (!move) return false
    }
    return true
  } catch {
    return false
  }
}
