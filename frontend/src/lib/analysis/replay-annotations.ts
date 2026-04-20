import { scoreToWhitePerspective } from '@/lib/stockfish/eval'
import type { UCIInfo } from '@/lib/stockfish/uci'

type ReplayMove = {
  ply: number
  san: string
  uci: string
  fen: string
}

type CachedEngineAnalysis = {
  bestMove: string | null
  depth: number
  lines: UCIInfo[]
}

export type ReplayMoveAnnotation = {
  ply: number
  san: string
  uci: string
  fen: string
  bestMove: string | null
  cpLoss: number | null
  label: 'Book' | 'Best' | 'Brilliant' | 'Excellent' | 'Good' | 'Inaccuracy' | 'Mistake' | 'Blunder' | null
}

type MoveQualityLabel = Exclude<ReplayMoveAnnotation['label'], 'Book' | 'Best' | 'Brilliant' | null>

function scoreToWhiteCp(score: UCIInfo['score'], fen: string) {
  const normalized = scoreToWhitePerspective(score, fen)

  if (normalized.type === 'mate') {
    return 1000 * Math.sign(normalized.value || 1)
  }

  return normalized.value
}

function moverPerspectiveCp(whiteCp: number, fen: string) {
  return fen.split(' ')[1] === 'b' ? whiteCp * -1 : whiteCp
}

export function classifyCpLoss(cpLoss: number): MoveQualityLabel {
  if (cpLoss <= 15) return 'Excellent'
  if (cpLoss <= 40) return 'Good'
  if (cpLoss <= 90) return 'Inaccuracy'
  if (cpLoss <= 200) return 'Mistake'
  return 'Blunder'
}

function getTopLine(analysis?: CachedEngineAnalysis) {
  return analysis?.lines[0] ?? null
}

function getCpLoss(parentFen: string, childFen: string, parent?: CachedEngineAnalysis, child?: CachedEngineAnalysis) {
  const parentTopLine = getTopLine(parent)
  const childTopLine = getTopLine(child)

  if (!parentTopLine || !childTopLine) {
    return null
  }

  const bestMoverCp = moverPerspectiveCp(scoreToWhiteCp(parentTopLine.score, parentFen), parentFen)
  const actualMoverCp = moverPerspectiveCp(scoreToWhiteCp(childTopLine.score, childFen), parentFen)

  return Math.max(0, bestMoverCp - actualMoverCp)
}

function getMaterialByColor(fen: string) {
  const pieceValues: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, P: 1, N: 3, B: 3, R: 5, Q: 9 }
  const position = fen.split(' ')[0]
  let white = 0
  let black = 0
  for (const ch of position) {
    if (ch >= 'A' && ch <= 'Z' && pieceValues[ch]) white += pieceValues[ch]
    else if (ch >= 'a' && ch <= 'z' && pieceValues[ch]) black += pieceValues[ch]
  }
  return { white, black }
}

function toMoverCp(score: UCIInfo['score'], fen: string): number {
  const n = scoreToWhitePerspective(score, fen)
  const cp = n.type === 'mate' ? 1000 * Math.sign(n.value || 1) : n.value
  return fen.split(' ')[1] === 'b' ? -cp : cp
}

function isBrilliantMove(
  move: ReplayMove,
  parentFen: string,
  childFen: string,
  parentAnalysis?: CachedEngineAnalysis,
  childAnalysis?: CachedEngineAnalysis,
  cpLoss?: number | null,
): boolean {
  if (!parentAnalysis || !parentAnalysis.bestMove) return false
  if (cpLoss == null || cpLoss > 10) return false
  if ((parentAnalysis.depth ?? 0) < 12) return false

  const moverIsWhite = parentFen.split(' ')[1] === 'w'
  const before = getMaterialByColor(parentFen)
  const after = getMaterialByColor(childFen)
  const moverBefore = moverIsWhite ? before.white : before.black
  const opponentBefore = moverIsWhite ? before.black : before.white
  const moverAfter = moverIsWhite ? after.white : after.black
  const opponentAfter = moverIsWhite ? after.black : after.white

  const moverLost = moverBefore - moverAfter
  const opponentLost = opponentBefore - opponentAfter
  const netSacrifice = moverLost - opponentLost
  if (netSacrifice < 1) return false

  const parentTopLine = parentAnalysis.lines[0]
  if (!parentTopLine) return false
  const evalBeforeMove = toMoverCp(parentTopLine.score, parentFen)
  if (evalBeforeMove > 500) return false

  if (parentAnalysis.lines.length >= 2) {
    const secondBest = parentAnalysis.lines.find((l) => l.multipv === 2)
    if (secondBest) {
      const bestCp = toMoverCp(parentTopLine.score, parentFen)
      const secondCp = toMoverCp(secondBest.score, parentFen)
      if (bestCp - secondCp >= 100) return true
    }
  }

  return netSacrifice >= 3
}

export function buildReplayMoveAnnotations({
  analysisByFen,
  bookPlies,
  fenHistory,
  implicitBookPlyLimit = 0,
  replayMoves,
}: {
  analysisByFen: Record<string, CachedEngineAnalysis>
  bookPlies: Set<number>
  fenHistory: string[]
  implicitBookPlyLimit?: number
  replayMoves: ReplayMove[]
}) {
  let stillInBook = true
  const hasExactBookSequence = bookPlies.size > 0

  return replayMoves.map((move, index) => {
    const parentFen = fenHistory[index]
    const parentAnalysis = parentFen ? analysisByFen[parentFen] : undefined
    const childAnalysis = analysisByFen[move.fen]
    const cpLoss = parentFen ? getCpLoss(parentFen, move.fen, parentAnalysis, childAnalysis) : null

    const isBadMove = cpLoss !== null && cpLoss > 40
    const isExactBookMove = bookPlies.has(move.ply)
    const isOpeningBookMove = hasExactBookSequence
      ? isExactBookMove
      : move.ply <= implicitBookPlyLimit

    if (!isBadMove && stillInBook && isOpeningBookMove) {
      return {
        bestMove: parentAnalysis?.bestMove ?? null,
        cpLoss,
        fen: move.fen,
        label: 'Book' as const,
        ply: move.ply,
        san: move.san,
        uci: move.uci,
      }
    }

    stillInBook = false

    const brilliant = parentFen
      ? isBrilliantMove(move, parentFen, move.fen, parentAnalysis, childAnalysis, cpLoss)
      : false

    if (brilliant) {
      return {
        bestMove: parentAnalysis?.bestMove ?? null,
        cpLoss,
        fen: move.fen,
        label: 'Brilliant' as const,
        ply: move.ply,
        san: move.san,
        uci: move.uci,
      }
    }

    if (parentAnalysis?.bestMove && move.uci === parentAnalysis.bestMove) {
      return {
        bestMove: parentAnalysis.bestMove,
        cpLoss,
        fen: move.fen,
        label: 'Best' as const,
        ply: move.ply,
        san: move.san,
        uci: move.uci,
      }
    }

    return {
      bestMove: parentAnalysis?.bestMove ?? null,
      cpLoss,
      fen: move.fen,
      label: cpLoss == null ? null : classifyCpLoss(cpLoss),
      ply: move.ply,
      san: move.san,
      uci: move.uci,
    }
  })
}
