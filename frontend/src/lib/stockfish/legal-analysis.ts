import { Chess, type Square } from 'chess.js'

import { memoize } from '@/lib/memo'

import type { UCIInfo } from './uci'

export type TerminalOutcome = { whiteResult: -1 | 0 | 1; reason: 'checkmate' | 'stalemate' }
type PositionFacts = { legalMoveCount: number | null; outcome: TerminalOutcome | null }
const positionFactsCache = new Map<string, PositionFacts>()

function getPositionFacts(fen: string): PositionFacts {
  const cached = positionFactsCache.get(fen)
  if (cached) return cached
  let outcome: TerminalOutcome | null = null
  let legalMoveCount: number | null = null
  try {
    const board = new Chess(toFullFen(fen))
    legalMoveCount = board.moves().length
    if (legalMoveCount === 0) {
      outcome = board.isCheck()
        ? { whiteResult: board.turn() === 'w' ? -1 : 1, reason: 'checkmate' }
        : { whiteResult: 0, reason: 'stalemate' }
    }
  } catch {
    // Invalid FENs are not terminal evidence.
  }
  const facts = { legalMoveCount, outcome }
  if (positionFactsCache.size >= 512) {
    positionFactsCache.delete(positionFactsCache.keys().next().value!)
  }
  positionFactsCache.set(fen, facts)
  return facts
}

/** Only FEN-local final facts; repetition and move-clock claims need game history. */
export function getTerminalOutcome(fen: string): TerminalOutcome | null {
  return getPositionFacts(fen).outcome
}

/** MultiPV cannot produce more alternatives than there are legal moves. */
export function getLegalMoveCount(fen: string): number | null {
  return getPositionFacts(fen).legalMoveCount
}

function toFullFen(fen: string): string {
  const parts = fen.split(' ')
  while (parts.length < 6) parts.push(parts.length === 4 ? '0' : '1')
  return parts.join(' ')
}

export function isLegalEngineMove(fen: string, uci: string | null | undefined): boolean {
  return uci ? isLegalMove(fen, uci) : false
}

// Checked for every engine info line (many a second), always against the same
// few positions: one board load per (position, move), not per line.
const isLegalMove = memoize(function isLegalMove(fen: string, uci: string): boolean {
  if (!uci || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return false

  try {
    const chess = new Chess(toFullFen(fen))
    const from = uci.slice(0, 2) as Square
    const to = uci.slice(2, 4)
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined
    return chess
      .moves({ square: from, verbose: true })
      .some((move) => move.to === to && move.promotion === promotion)
  } catch {
    return false
  }
})

export function isLegalEngineLine(fen: string, line: UCIInfo): boolean {
  if (!line.pv.length) return false
  // An already checkmated root cannot also have a playable principal variation.
  if (line.score?.type === 'mate' && line.score.value === 0) return false

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
