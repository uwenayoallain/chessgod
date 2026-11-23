import { Chess } from 'chess.js'
import { scoreToWhitePerspective } from '@/lib/stockfish/eval'
import { getTerminalOutcome } from '@/lib/stockfish/legal-analysis'
import type { UCIInfo } from '@/lib/stockfish/uci'

import { DECISIVE_CP } from './review-depth'

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
  label:
    | 'Book'
    | 'Best'
    | 'Brilliant'
    | 'Excellent'
    | 'Good'
    | 'Inaccuracy'
    | 'Mistake'
    | 'Blunder'
    | 'Missed Win'
    | null
}

type MoveQualityLabel = Exclude<
  ReplayMoveAnnotation['label'],
  'Book' | 'Best' | 'Brilliant' | 'Missed Win' | null
>

function scoreToWhiteCp(score: UCIInfo['score'], fen: string) {
  const normalized = scoreToWhitePerspective(score, fen)

  if (normalized.type === 'mate') {
    const distance = Math.min(20, Math.abs(normalized.value))
    return normalized.value > 0 ? 2000 - distance * 10 : -2000 + distance * 10
  }

  return capDecisive(normalized.value)
}

function capDecisive(cp: number) {
  return Math.max(-DECISIVE_CP, Math.min(DECISIVE_CP, cp))
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
  // Live iterations are useful while exploring, but too shallow to grade a
  // historical decision. Use the actual rank-one depth, not a cache label.
  return analysis?.lines.find((line) => line.multipv === 1 && line.depth >= 18) ?? null
}

function getCpLoss(
  parentFen: string,
  childFen: string,
  parent?: CachedEngineAnalysis,
  child?: CachedEngineAnalysis,
) {
  const parentTopLine = getTopLine(parent)
  const childTopLine = getTopLine(child)
  const terminal = getTerminalOutcome(childFen)

  if (!parentTopLine || (!childTopLine && !terminal)) {
    return null
  }

  // UCI scores are relative to the side to move at the parent. A forced loss
  // cannot lose further winning chances by shortening mate or changing scale.
  if (parentTopLine.score.type === 'mate' && parentTopLine.score.value < 0) return 0

  const bestMoverCp = moverPerspectiveCp(scoreToWhiteCp(parentTopLine.score, parentFen), parentFen)
  if (terminal) {
    const resultForMover =
      parentFen.split(' ')[1] === 'w' ? terminal.whiteResult : -terminal.whiteResult
    if (resultForMover > 0) return 0 // Delivering mate cannot lose winning chances.
    return Math.max(0, bestMoverCp - resultForMover * 2000)
  }
  const actualScore = scoreToWhitePerspective(childTopLine!.score, childFen)
  if (actualScore.type === 'mate' && moverPerspectiveCp(actualScore.value, parentFen) > 0) {
    // A slower forced mate still wins. Its synthetic CP value must not turn
    // preserving that win into an error, even after a very large CP score.
    return 0
  }
  const actualMoverCp = moverPerspectiveCp(scoreToWhiteCp(childTopLine!.score, childFen), parentFen)

  return Math.max(0, bestMoverCp - actualMoverCp)
}

function toMoverCp(score: UCIInfo['score'], fen: string): number {
  const n = scoreToWhitePerspective(score, fen)
  const cp =
    n.type === 'mate'
      ? n.value > 0
        ? 2000 - Math.min(20, Math.abs(n.value)) * 10
        : -2000 + Math.min(20, Math.abs(n.value)) * 10
      : capDecisive(n.value)
  return fen.split(' ')[1] === 'b' ? -cp : cp
}

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

/**
 * Does the side that just moved leave a piece to be taken for less than it is
 * worth? Judged on the board, two plies deep: for every capture the opponent
 * has, the piece taken against the cheapest way the mover can recapture. A
 * knight or better hanging with no recapture, or taken by something cheaper
 * with the recapture not making up the difference, is a sacrifice. A pawn is
 * not: every sound gambit would be brilliant.
 *
 * This is how Chess.com reads a sacrifice — what *could* be taken — rather
 * than whether the engine's reply takes it, which is what the earlier rule
 * looked at and so missed every sacrifice the engine declines.
 */
export function isSacrifice(childFen: string, gainedByMove = 0): boolean {
  let board: Chess
  try {
    board = new Chess(childFen.split(' ').length >= 6 ? childFen : `${childFen} 0 1`)
  } catch {
    return false
  }
  const captures = board.moves({ verbose: true }).filter((move) => move.captured)
  for (const capture of captures) {
    const taken = PIECE_VALUE[capture.captured ?? 'p'] ?? 0
    if (taken < 3) continue
    const taker = PIECE_VALUE[capture.piece] ?? 0
    const after = new Chess(board.fen())
    try {
      after.move({ from: capture.from, to: capture.to, promotion: capture.promotion })
    } catch {
      continue
    }
    const recaptures = after
      .moves({ verbose: true })
      .filter((move) => move.to === capture.to && move.captured)
    // What the move itself captured comes off the loss: Nxe5 winning a pawn
    // and then losing the knight for it is a trade gone wrong, not a sacrifice.
    const loss = taken - (recaptures.length ? taker : 0) - gainedByMove
    if (loss >= 2) return true
  }
  return false
}

/** The value of what a move captured, read from the position it was played in. */
function capturedValue(parentFen: string, uci: string): number {
  try {
    const board = new Chess(parentFen.split(' ').length >= 6 ? parentFen : `${parentFen} 0 1`)
    const move = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.slice(4) || undefined,
    })
    return move.captured ? (PIECE_VALUE[move.captured] ?? 0) : 0
  } catch {
    return 0
  }
}

/**
 * Brilliant, the way Chess.com awards it: a piece sacrifice (see
 * `isSacrifice`) that is the engine's move or nearly so, made from a position
 * that was not already won, into one that is not lost.
 */
function isBrilliantMove(
  move: ReplayMove,
  parentFen: string,
  childFen: string,
  parentAnalysis?: CachedEngineAnalysis,
  childAnalysis?: CachedEngineAnalysis,
  cpLoss?: number | null,
): boolean {
  if (!parentAnalysis?.bestMove) return false
  if (cpLoss == null || cpLoss > 30) return false

  const parentTopLine = getTopLine(parentAnalysis)
  const childTopLine = getTopLine(childAnalysis)
  if (!parentTopLine || !childTopLine) return false

  // Already winning outright: giving material back is not brilliance.
  if (toMoverCp(parentTopLine.score, parentFen) > 500) return false
  // The child is the opponent's turn; negate to read it from the mover's side.
  if (-toMoverCp(childTopLine.score, childFen) < -100) return false

  return isSacrifice(childFen, capturedValue(parentFen, move.uci))
}

/**
 * The engine's evaluation of a position from the side to move, capped like
 * every grade here, or null while the position is not searched deep enough.
 */
export function moverCpOf(fen: string, analysis?: CachedEngineAnalysis): number | null {
  const line = getTopLine(analysis)
  return line ? toMoverCp(line.score, fen) : null
}

/** A won position, in centipawns from the mover's side. */
const WINNING_CP = 500
/** Below this the win is gone, not merely smaller. */
const WIN_LOST_CP = 150

/**
 * Did this move throw away a win?
 *
 * "Blunder" says the evaluation fell a long way; it does not say the game was
 * won beforehand, which is the part worth learning from. This label had an
 * icon, a tone and a tooltip from the start and was never once produced — no
 * code path assigned it.
 *
 * It only replaces an error, never a good move: a win that survives a small
 * inaccuracy is still a win.
 */
function isMissedWin(
  parentFen: string,
  childFen: string,
  parentAnalysis?: CachedEngineAnalysis,
  childAnalysis?: CachedEngineAnalysis,
  cpLoss?: number | null,
): boolean {
  if (cpLoss == null || cpLoss <= 90) return false

  const parentTopLine = getTopLine(parentAnalysis)
  const childTopLine = getTopLine(childAnalysis)
  if (!parentTopLine || !childTopLine) return false

  const before = toMoverCp(parentTopLine.score, parentFen)
  if (before < WINNING_CP) return false

  // The child position is the opponent's turn, so `toMoverCp` reads it from
  // their side. Negate to keep both readings on the mover's side of the board.
  const after = -toMoverCp(childTopLine.score, childFen)
  return after < WIN_LOST_CP
}

type MoveMeasurement = {
  cpLoss: number | null
  matchesBest: boolean
  brilliant: boolean
  missedWin: boolean
}

// Grading a move is a pure function of its two positions' analyses, and the
// cache replaces an analysis object whenever it changes. Keyed on those
// objects, a move is graded once per evaluation it depends on: stepping
// through a game re-graded all of its moves on every step (~48ms of a 170-move
// game's ~115ms per step, measured).
const NO_ANALYSIS = {}
const measurements = new WeakMap<object, WeakMap<object, Map<string, MoveMeasurement>>>()

function measureMove(
  parentFen: string | undefined,
  move: ReplayMove,
  parentAnalysis: CachedEngineAnalysis | undefined,
  childAnalysis: CachedEngineAnalysis | undefined,
): MoveMeasurement {
  const byChild =
    measurements.get(parentAnalysis ?? NO_ANALYSIS) ??
    measurements
      .set(parentAnalysis ?? NO_ANALYSIS, new WeakMap())
      .get(parentAnalysis ?? NO_ANALYSIS)!
  const byMove =
    byChild.get(childAnalysis ?? NO_ANALYSIS) ??
    byChild.set(childAnalysis ?? NO_ANALYSIS, new Map()).get(childAnalysis ?? NO_ANALYSIS)!
  const key = `${parentFen}|${move.uci}|${move.fen}`
  const cached = byMove.get(key)
  if (cached) return cached

  const measuredLoss = parentFen
    ? getCpLoss(parentFen, move.fen, parentAnalysis, childAnalysis)
    : null
  const matchesBest = move.uci === getTopLine(parentAnalysis)?.pv[0]
  // Re-searching a best move's child can change its score. That search
  // variation is not a mistake made by the player.
  const cpLoss = measuredLoss != null && matchesBest ? 0 : measuredLoss
  const measurement = {
    cpLoss,
    matchesBest,
    brilliant: parentFen
      ? isBrilliantMove(move, parentFen, move.fen, parentAnalysis, childAnalysis, cpLoss)
      : false,
    missedWin: parentFen
      ? isMissedWin(parentFen, move.fen, parentAnalysis, childAnalysis, cpLoss)
      : false,
  }
  byMove.set(key, measurement)
  return measurement
}

export function buildReplayMoveAnnotations({
  analysisByFen,
  bookPlies,
  fenHistory,
  replayMoves,
}: {
  analysisByFen: Record<string, CachedEngineAnalysis>
  bookPlies: Set<number>
  fenHistory: string[]
  implicitBookPlyLimit?: number
  replayMoves: ReplayMove[]
}) {
  let stillInBook = true

  return replayMoves.map((move, index) => {
    const parentFen = fenHistory[index]
    const parentAnalysis = parentFen ? analysisByFen[parentFen] : undefined
    const childAnalysis = analysisByFen[move.fen]
    const { cpLoss, matchesBest, brilliant, missedWin } = measureMove(
      parentFen,
      move,
      parentAnalysis,
      childAnalysis,
    )

    const isBadMove = cpLoss !== null && cpLoss > 40
    const isExactBookMove = bookPlies.has(move.ply)
    const isOpeningBookMove = isExactBookMove

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

    if (parentAnalysis?.bestMove && matchesBest && cpLoss !== null) {
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
      label: missedWin ? ('Missed Win' as const) : cpLoss == null ? null : classifyCpLoss(cpLoss),
      ply: move.ply,
      san: move.san,
      uci: move.uci,
    }
  })
}
