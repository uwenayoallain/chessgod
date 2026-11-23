import { Chess } from 'chess.js'

import type { UCIInfo } from '@/lib/stockfish/uci'

export type SparColor = 'white' | 'black'
export type SparResult = 'win' | 'loss' | 'draw'

export type SparOutcome = {
  /** From the player's side of the board. */
  result: SparResult
  reason:
    | 'checkmate'
    | 'stalemate'
    | 'insufficient material'
    | 'repetition'
    | 'resignation'
    | 'timeout'
    | 'timeout vs insufficient material'
}

/**
 * How far one game moves the opponent's strength. The opponent starts where
 * the calibration says it plays like the player, then walks toward an even
 * match: stronger after a win, weaker after a loss.
 */
export const SPAR_ELO_STEP = 40

/** The strength range offered, in Chess.com-style rating points. */
export const SPAR_MIN_RATING = 400
export const SPAR_MAX_RATING = 2800

export function clampSparRating(rating: number) {
  if (!Number.isFinite(rating)) return SPAR_MIN_RATING
  return Math.round(Math.min(SPAR_MAX_RATING, Math.max(SPAR_MIN_RATING, rating)))
}

/*
 * How the opponent chooses a move. Stockfish's own limiter (`UCI_Elo`) picks
 * from a search one ply deep plus random noise at its lowest setting, and it
 * read as "brainless": principled moves, then a piece thrown away.
 *
 * So the opponent looks at its eight best-looking moves with a full-strength
 * search cut off at a short horizon, and picks among them with a probability
 * that falls with how much worse each looks: p ∝ exp((score − best) / T).
 *
 * Calibrated on 69 positions from the player's own rapid games, graded move
 * by move against a depth-12 judge (the method is in CLAUDE.md). The limiter
 * matched the player's average loss (~80cp) only by playing a move a two-ply
 * look already shows losing two pawns on 8.6% of moves — that is what
 * brainless measured as. No setting can be that weak without it: a sensible
 * chooser tops out near 50cp. At CALIBRATION_RATING this plays depth 2, T 110:
 * ~50cp a move, 2.2% of moves losing three pawns, 4.0% visibly bad — beatable,
 * and half as brainless. Stronger adds horizon and lowers T; weaker raises T.
 */
export const CALIBRATION_RATING = 1669
const CALIBRATED_DEPTH = 2
const CALIBRATED_TEMPERATURE = 110
/** Every this many rating points doubles (weaker) or halves (stronger) the temperature. */
const TEMPERATURE_DOUBLING_POINTS = 300
/** Past the calibration point, every this many points adds a ply of horizon. */
const DEPTH_STEP_POINTS = 200
export const SPAR_CANDIDATES = 8

export type SparSearch = { depth: number; multiPV: number; temperature: number }

export function sparSearchParams(rating: number): SparSearch {
  const offset = clampSparRating(rating) - CALIBRATION_RATING
  // Never below a two-ply horizon: a one-ply chooser is the limiter again.
  const extraDepth = Math.max(0, Math.floor((offset + DEPTH_STEP_POINTS / 2) / DEPTH_STEP_POINTS))
  return {
    depth: Math.min(12, CALIBRATED_DEPTH + extraDepth),
    multiPV: SPAR_CANDIDATES,
    temperature: Math.min(
      400,
      Math.max(5, CALIBRATED_TEMPERATURE * 2 ** (-offset / TEMPERATURE_DOUBLING_POINTS)),
    ),
  }
}

/** A line's score for the side to move, on the drill pipeline's capped scale. */
function lineScore(score: UCIInfo['score']) {
  if (score.type === 'mate') {
    const distance = Math.min(20, Math.abs(score.value))
    return score.value > 0 ? 2000 - distance * 10 : -2000 + distance * 10
  }
  return Math.max(-1500, Math.min(1500, score.value))
}

/**
 * Pick one of the candidate lines: the best-looking most often, a worse one
 * with a probability that falls exponentially with how much worse it looks.
 */
export function chooseSparMove(
  lines: UCIInfo[],
  temperature: number,
  random: () => number = Math.random,
): string | null {
  const candidates = lines.filter((line) => line.pv[0])
  if (!candidates.length) return null
  const scores = candidates.map((line) => lineScore(line.score))
  const top = Math.max(...scores)
  const weights = scores.map((score) => Math.exp((score - top) / Math.max(1, temperature)))
  let pick = random() * weights.reduce((sum, weight) => sum + weight, 0)
  for (const [index, weight] of weights.entries()) {
    pick -= weight
    if (pick <= 0) return candidates[index].pv[0]
  }
  return candidates.at(-1)!.pv[0]
}

/** Past this many plies the opponent stops consulting the book. */
export const SPAR_BOOK_PLIES = 30
/** A book move needs this share of the master games from the position… */
const BOOK_MIN_SHARE = 0.03
/** …and at least this many games, or it is a sideline nobody at this level plays. */
const BOOK_MIN_GAMES = 20

/**
 * An opening move the way a person picks one: from the book, in proportion to
 * how often masters play it. Engine randomness among near-equal opening moves
 * produced 1.e4 c6 2.Nf3 Qc7 3.Bc4 Qa5; nobody plays like that. Returns null
 * out of book, when the engine chooser takes over.
 */
export function chooseBookMove(
  fen: string,
  masterMoves: Array<{ uci?: string | null; game_count: number }>,
  random: () => number = Math.random,
): string | null {
  const total = masterMoves.reduce((sum, move) => sum + Math.max(0, move.game_count), 0)
  if (!total) return null
  const book = masterMoves.filter(
    (move): move is { uci: string; game_count: number } =>
      Boolean(move.uci) &&
      move.game_count >= BOOK_MIN_GAMES &&
      move.game_count / total >= BOOK_MIN_SHARE &&
      applyUciMove(fen, move.uci!) !== null,
  )
  if (!book.length) return null
  let pick = random() * book.reduce((sum, move) => sum + move.game_count, 0)
  for (const move of book) {
    pick -= move.game_count
    if (pick <= 0) return move.uci
  }
  return book.at(-1)!.uci
}

function toFullFen(fen: string) {
  const parts = fen.trim().split(/\s+/)
  while (parts.length < 6) parts.push(parts.length === 4 ? '0' : '1')
  return parts.join(' ')
}

/** The four FEN fields that decide whether two positions repeat. */
function repetitionKey(fen: string) {
  return fen.trim().split(/\s+/).slice(0, 4).join(' ')
}

export function sideToMove(fen: string): SparColor {
  return fen.trim().split(/\s+/)[1] === 'b' ? 'black' : 'white'
}

/**
 * Whether the game on the board has ended, judged over the line that led to
 * it. `lineFens` runs from the first position of the game to the current one;
 * it is what makes a threefold repetition visible. The fifty-move rule is left
 * to the players: the app stores positions without the move counters.
 */
export function sparOutcome(lineFens: string[], userColor: SparColor): SparOutcome | null {
  const current = lineFens.at(-1)
  if (!current) return null

  let board: Chess
  try {
    board = new Chess(toFullFen(current))
  } catch {
    return null
  }

  if (board.isCheckmate()) {
    return {
      // The side to move has been mated.
      result: sideToMove(current) === userColor ? 'loss' : 'win',
      reason: 'checkmate',
    }
  }
  if (board.isStalemate()) return { result: 'draw', reason: 'stalemate' }
  if (board.isInsufficientMaterial()) return { result: 'draw', reason: 'insufficient material' }

  const key = repetitionKey(current)
  const occurrences = lineFens.filter((fen) => repetitionKey(fen) === key).length
  if (occurrences >= 3) return { result: 'draw', reason: 'repetition' }

  return null
}

/** The opponent's strength for the next game. */
export function nextSparElo(elo: number, result: SparResult) {
  if (result === 'win') return clampSparRating(elo + SPAR_ELO_STEP)
  if (result === 'loss') return clampSparRating(elo - SPAR_ELO_STEP)
  return clampSparRating(elo)
}

/**
 * Where a new player's opponent starts: their own most recent rating, in the
 * time control they play most slowly, since that is where they think hardest.
 */
export function startingSparElo(ratings: Partial<Record<string, number>> | null | undefined) {
  const rating = ratings?.rapid ?? ratings?.blitz ?? ratings?.daily ?? ratings?.bullet
  return clampSparRating(rating ?? 1200)
}

/**
 * How long the opponent takes over a move. An instant reply reads as a
 * machine and gives the player no rhythm; a real opponent's time varies.
 */
export function sparMoveTimeMs(random: () => number = Math.random) {
  return Math.round(500 + random() * 900)
}

/** Resolve a UCI move on `fen` into what the board records for it. */
export function applyUciMove(fen: string, uci: string) {
  try {
    const board = new Chess(toFullFen(fen))
    const move = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    })
    if (!move) return null
    return {
      fen: repetitionKey(board.fen()),
      san: move.san,
      uci: move.from + move.to + (move.promotion ?? ''),
    }
  } catch {
    return null
  }
}

/** Clock choices, in seconds per side; null is an untimed game. */
export const SPAR_TIME_CONTROLS = [null, 600, 300, 180] as const
export type SparTimeControl = (typeof SPAR_TIME_CONTROLS)[number]

/**
 * Who a flag fall favours. Running out of time loses, except that it is a draw
 * when the side still on the clock has too little material to ever mate —
 * the rule over the board, and the one Chess.com applies.
 */
export function timeoutOutcome(fen: string, flagged: SparColor, userColor: SparColor): SparOutcome {
  const placement = fen.trim().split(/\s+/)[0]
  const winner = flagged === 'white' ? 'black' : 'white'
  const pieces = placement.split('').filter((char) => /[a-z]/i.test(char))
  const winnerPieces = pieces.filter((char) =>
    winner === 'white' ? char === char.toUpperCase() : char === char.toLowerCase(),
  )
  const canMate = winnerPieces.some((char) => /[pqr]/i.test(char)) || winnerPieces.length > 2
  if (!canMate) return { result: 'draw', reason: 'timeout vs insufficient material' }
  return { result: flagged === userColor ? 'loss' : 'win', reason: 'timeout' }
}

/** A clock reading as m:ss, or s.t under ten seconds. */
export function formatClock(ms: number) {
  const clamped = Math.max(0, ms)
  if (clamped < 10_000) return (clamped / 1000).toFixed(1)
  const total = Math.ceil(clamped / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function describeOutcome(outcome: SparOutcome) {
  if (outcome.reason === 'timeout') {
    return outcome.result === 'win' ? 'Stockfish ran out of time.' : 'You ran out of time.'
  }
  if (outcome.result === 'win') {
    return outcome.reason === 'resignation'
      ? 'The engine resigned.'
      : `You won by ${outcome.reason}.`
  }
  if (outcome.result === 'loss') {
    return outcome.reason === 'resignation' ? 'You resigned.' : `You lost by ${outcome.reason}.`
  }
  if (outcome.reason === 'timeout vs insufficient material') {
    return 'Draw: the flag fell, but the other side cannot mate.'
  }
  return `Draw by ${outcome.reason}.`
}

/**
 * The Play panel's line about the review of a finished game. It must end when
 * the review does: "Reviewing…" used to hold until the drills were posted,
 * and never changed if that post failed.
 */
export function describeReviewStatus({
  savedGameId,
  mistakesPosted,
  reviewSettled,
}: {
  savedGameId: number | null
  mistakesPosted: number | 'failed' | null
  reviewSettled: boolean
}): string {
  if (mistakesPosted === 'failed') return 'Reviewed. The drills could not be saved this time.'
  if (typeof mistakesPosted === 'number') {
    return mistakesPosted === 0
      ? 'Reviewed. No mistakes to drill from this one.'
      : `Reviewed: ${mistakesPosted.toLocaleString()} ${mistakesPosted === 1 ? 'mistake' : 'mistakes'} added to your drills.`
  }
  if (reviewSettled && savedGameId != null) return 'Reviewed. Adding the drills…'
  return 'Reviewing the game…'
}
