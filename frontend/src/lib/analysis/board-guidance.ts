import { Chess, type Square } from 'chess.js'
import type { CSSProperties } from 'react'

import { findOpponentHangingPieceThreat } from './hanging-threats'

export const BEST_MOVE_ARROW_COLOR = 'rgba(20, 184, 166, 0.72)'
export const THREAT_ARROW_COLOR = 'rgba(239, 68, 68, 0.72)'

export type BoardArrow = {
  startSquare: string
  endSquare: string
  color: string
}

export function getLatestMoveSquares(uci: string | null | undefined): [string, string] | null {
  if (!uci || uci.length < 4) return null
  return [uci.slice(0, 2), uci.slice(2, 4)]
}

export function buildLatestMoveSquareStyles(uci: string | null | undefined): Record<string, CSSProperties> {
  const squares = getLatestMoveSquares(uci)
  if (!squares) return {}

  const [from, to] = squares
  return {
    [from]: {
      backgroundColor: 'rgba(250, 204, 21, 0.3)',
      boxShadow: 'inset 0 0 0 3px rgba(250, 204, 21, 0.55)',
    },
    [to]: {
      backgroundColor: 'rgba(250, 204, 21, 0.2)',
      boxShadow: 'inset 0 0 0 3px rgba(250, 204, 21, 0.45)',
    },
  }
}

function isLegalUciMove(fen: string, uci: string) {
  const squares = getLatestMoveSquares(uci)
  if (!squares) return false

  try {
    const chess = new Chess(fen)
    const [from, to] = squares
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined
    return chess
      .moves({ square: from as Square, verbose: true })
      .some((move) => move.to === to && (!promotion || move.promotion === promotion))
  } catch {
    return false
  }
}

function uciToArrow(uci: string | null | undefined, fen: string, color: string): BoardArrow | null {
  if (!uci) return null
  const squares = getLatestMoveSquares(uci)
  if (!squares) return null
  if (!isLegalUciMove(fen, uci)) return null
  const [startSquare, endSquare] = squares
  return { color, endSquare, startSquare }
}

export function buildGuidanceArrows({ bestMove, fen }: { bestMove: string | null | undefined; fen: string }): BoardArrow[] {
  const arrows: BoardArrow[] = []
  const bestArrow = uciToArrow(bestMove, fen, BEST_MOVE_ARROW_COLOR)
  if (bestArrow) {
    arrows.push(bestArrow)
  }

  const threat = findOpponentHangingPieceThreat(fen)
  if (threat) {
    arrows.push({
      color: THREAT_ARROW_COLOR,
      endSquare: threat.to,
      startSquare: threat.from,
    })
  }

  return arrows
}
