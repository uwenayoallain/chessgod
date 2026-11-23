import { Chess, type Square } from 'chess.js'
import type { CSSProperties } from 'react'

import { findOpponentHangingPieceThreat } from './hanging-threats'

// Deep amber reads cleanly on both warm parchment and walnut squares;
// red is reserved for the hanging-piece threat arrow.
export const BEST_MOVE_ARROW_COLOR = 'rgba(234, 138, 16, 0.9)'
export const THREAT_ARROW_COLOR = 'rgba(214, 60, 45, 0.88)'
/**
 * "Play this": a trainer's hint or answer arrow. Green matches the app's
 * primary action accent and contrasts sharply against the walnut board squares.
 */
export const PLAY_ARROW_COLOR = 'rgba(38, 174, 82, 0.92)'
export const LAST_MOVE_SQUARE = 'rgba(205, 210, 106, 0.56)'

export type BoardArrow = {
  startSquare: string
  endSquare: string
  color: string
}

export function getLatestMoveSquares(uci: string | null | undefined): [string, string] | null {
  if (!uci || uci.length < 4) return null
  return [uci.slice(0, 2), uci.slice(2, 4)]
}

export function buildLatestMoveSquareStyles(
  uci: string | null | undefined,
): Record<string, CSSProperties> {
  const squares = getLatestMoveSquares(uci)
  if (!squares) return {}

  const [from, to] = squares
  const overlay = { backgroundImage: `linear-gradient(${LAST_MOVE_SQUARE}, ${LAST_MOVE_SQUARE})` }
  return { [from]: { ...overlay }, [to]: { ...overlay } }
}

export function isLegalUciMove(fen: string, uci: string) {
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

export function buildGuidanceArrows({
  bestMove,
  fen,
}: {
  bestMove: string | null | undefined
  fen: string
}): BoardArrow[] {
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
