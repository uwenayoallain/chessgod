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

function getMaterialByColor(fen: string) {
  const pieceValues: Record<string, number> = {
    p: 1,
    n: 3,
    b: 3,
    r: 5,
    q: 9,
    P: 1,
    N: 3,
    B: 3,
    R: 5,
    Q: 9,
  }
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
  const cp =
    n.type === 'mate'
      ? n.value > 0
        ? 2000 - Math.min(20, Math.abs(n.value)) * 10
        : -2000 + Math.min(20, Math.abs(n.value)) * 10
      : capDecisive(n.value)
  return fen.split(' ')[1] === 'b' ? -cp : cp
}

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

/** The piece on `square` in a FEN placement, or null for an empty square. */
function pieceAt(placement: string, square: string): string | null {
  const file = square.charCodeAt(0) - 97
  const rank = Number(square[1])
  const row = placement.split('/')[8 - rank]
  if (row === undefined || file < 0 || file > 7) return null
  let column = 0
  for (const char of row) {
    if (char >= '1' && char <= '8') {
      column += Number(char)
    } else {
      if (column === file) return char
      column += 1
    }
    if (column > file) return null
  }
  return null
}

/**
 * Material both sides hold after `replyUci` is played in `fen`.
 *
 * Returns null when the reply does not start from a piece of the side to move,
 * so an unknown or stale line leaves the move ungraded rather than guessing a
 * sacrifice into existence. Counted from the board directly: replaying it with
 * chess.js cost a board load per move, on every re-grade of the whole game.
 */
function materialAfterReply(fen: string, replyUci: string) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(replyUci)) return null
  const [placement, turn] = fen.split(' ')
  const mover = pieceAt(placement, replyUci.slice(0, 2))
  if (!mover || (turn === 'w') !== (mover === mover.toUpperCase())) return null
  const material = getMaterialByColor(fen)
  const replierIsWhite = turn === 'w'
  let captured = pieceAt(placement, replyUci.slice(2, 4))
  // En passant: a pawn changing file onto an empty square takes a pawn.
  if (!captured && mover.toLowerCase() === 'p' && replyUci[0] !== replyUci[2]) captured = 'p'
  if (captured) {
    const value = PIECE_VALUE[captured.toLowerCase()] ?? 0
    if (replierIsWhite) material.black -= value
    else material.white -= value
  }
  if (replyUci.length > 4) {
    const gain = (PIECE_VALUE[replyUci[4]] ?? 0) - 1
    if (replierIsWhite) material.white += gain
    else material.black += gain
  }
  return material
}

/**
 * A sacrifice that is still the engine's move.
 *
 * **A sacrifice is not visible in the child position.** That is the ply on
 * which the player is briefly *up* material — Bxh7+ wins a pawn, and only loses
 * the bishop when the king recaptures. Comparing parent to child therefore
 * measures the opposite of what it means to sacrifice: for any move, the
 * mover's own material cannot fall, so `moverLost - opponentLost` was never
 * positive and `Brilliant` could not be awarded at all. It had no test, which
 * is why nobody noticed.
 *
 * So the judgement waits one more ply, for the opponent's best reply out of the
 * child position's own analysis. No reply, no verdict.
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
  if (cpLoss == null || cpLoss > 10) return false

  const parentTopLine = getTopLine(parentAnalysis)
  const childTopLine = getTopLine(childAnalysis)
  if (!parentTopLine || !childTopLine) return false

  // Handing material back while already winning is not brilliance.
  if (toMoverCp(parentTopLine.score, parentFen) > 500) return false

  const reply = childTopLine.pv[0]
  if (!reply) return false
  const after = materialAfterReply(childFen, reply)
  if (!after) return false

  const moverIsWhite = parentFen.split(' ')[1] === 'w'
  const before = getMaterialByColor(parentFen)
  const moverLost =
    (moverIsWhite ? before.white : before.black) - (moverIsWhite ? after.white : after.black)
  const opponentLost =
    (moverIsWhite ? before.black : before.white) - (moverIsWhite ? after.black : after.white)
  const netSacrifice = moverLost - opponentLost
  if (netSacrifice < 1) return false

  // A piece-level investment speaks for itself. A pawn has to also be the one
  // move that works, or every sound gambit becomes brilliant.
  if (netSacrifice >= 2) return true

  const secondBest = parentAnalysis.lines.find((l) => l.multipv === 2)
  if (!secondBest || secondBest.depth !== parentTopLine.depth) return false
  return toMoverCp(parentTopLine.score, parentFen) - toMoverCp(secondBest.score, parentFen) >= 100
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
