import { create } from 'zustand'

import {
  clampSparRating,
  sideToMove,
  SPAR_TIME_CONTROLS,
  type SparTimeControl,
  nextSparElo,
  startingSparElo,
  type SparColor,
  type SparOutcome,
} from '@/lib/sparring/sparring'

export type SparStatus = 'idle' | 'playing' | 'over'

type StoredStrength = { elo: number; games: number }

type SparState = {
  status: SparStatus
  userColor: SparColor
  /** Opponent strength for this game. */
  elo: number
  /**
   * Only a game from the starting position, played without takebacks, moves
   * the opponent's strength: a position handed over mid-game is already won or
   * lost, and a takeback is a different game.
   */
  rated: boolean
  /** Where the game came from, e.g. "boss:<line id>" for a boss fight; decides its XP. */
  origin: string | null
  /** `treeEpoch` at the start; a different value means the line was replaced. */
  epoch: number
  outcome: SparOutcome | null
  eloChange: number
  /**
   * The finished game being reviewed: which side the player had, and the
   * `treeEpoch` of its line, so the review can say "Stockfish" rather than
   * "Opponent" until something else is loaded.
   */
  reviewing: { userColor: SparColor; epoch: number } | null
  /**
   * A strength picked by hand with − / +. Held in memory only: it lasts until
   * it is reset or the page reloads, and games played at it are unrated, so
   * it never becomes the saved calibration.
   */
  override: number | null
  setOverride: (elo: number | null) => void
  /** The finished game once it is saved, and the mistakes its review sent to drills. */
  savedGameId: number | null
  // How many drills the review added; 'failed' when the post did not go through.
  mistakesPosted: number | 'failed' | null
  // The review's search is over (or never needed): the game can be read as reviewed.
  reviewSettled: boolean
  /** Seconds per side for the next game (null: no clock), and the running clocks. */
  timeControlSeconds: SparTimeControl
  setTimeControl: (seconds: SparTimeControl) => void
  /** Time left per side at the last move, in ms; null in an untimed game. */
  clocks: { white: number; black: number } | null
  /** The side whose clock is running, and since when (ms since epoch). */
  clockSide: SparColor | null
  turnStartedAt: number | null
  /** The position at the end of the game line when the clock last switched. */
  clockFen: string | null
  /** A move reached the end of the line: charge its maker and start the other clock. */
  chargeMove: (mover: SparColor, now: number, fen: string) => void
  recordSaved: (gameId: number) => void
  recordMistakes: (count: number | 'failed') => void
  settleReview: () => void
  /** A saved game put back on the board: reviewed as You / Stockfish, never re-saved. */
  reviewSaved: (userColor: SparColor, epoch: number) => void
  start: (options: {
    userColor: SparColor
    elo: number
    rated: boolean
    epoch: number
    /** The position the game starts from; its side to move starts the clock. */
    fen: string
    origin?: string | null
  }) => void
  finish: (outcome: SparOutcome, username: string | null) => void
  markUnrated: () => void
  /** Leave the game; the line stays on the board for review. */
  close: (options?: { review?: boolean }) => void
}

// v2: strengths are on the calibrated rating scale. The first build stored
// Stockfish's `UCI_Elo`, ~350 points off, so those entries are left behind.
function storageKey(username: string) {
  return `chessgod.sparringStrength.v2.${username.toLowerCase()}`
}

/**
 * The opponent strength this player's rated games have settled on, if any.
 *
 * Only finished rated games write here. An entry with no games behind it was
 * left by an earlier build, which saved hand-picked strengths permanently; it
 * is ignored so a temporary choice cannot outlive the session.
 */
export function readSparStrength(username: string | null): StoredStrength | null {
  if (!username || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(storageKey(username))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredStrength>
    const games = Number(parsed.games) || 0
    if (typeof parsed.elo !== 'number' || games < 1) return null
    return { elo: clampSparRating(parsed.elo), games }
  } catch {
    return null
  }
}

export function writeSparStrength(username: string | null, strength: StoredStrength) {
  if (!username || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey(username), JSON.stringify(strength))
  } catch {
    // A preference that cannot be saved still applies for this session.
  }
}

/** The opponent strength to offer: where the player left off, else their rating. */
export function resolveSparElo(
  username: string | null,
  ratings: Partial<Record<string, number>> | null | undefined,
) {
  return readSparStrength(username)?.elo ?? startingSparElo(ratings)
}

const TIME_CONTROL_KEY = 'chessgod.sparringTimeControl'

function readTimeControl(): SparTimeControl {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(TIME_CONTROL_KEY)
    const value = raw === null || raw === 'none' ? null : Number(raw)
    return (SPAR_TIME_CONTROLS as readonly (number | null)[]).includes(value)
      ? (value as SparTimeControl)
      : null
  } catch {
    return null
  }
}

function writeTimeControl(seconds: SparTimeControl) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(TIME_CONTROL_KEY, seconds == null ? 'none' : String(seconds))
  } catch {
    // A preference that cannot be saved still applies this session.
  }
}

/** The clocks with the running side charged up to `now`, and stopped. */
function stoppedClocks(
  state: Pick<SparState, 'clocks' | 'clockSide' | 'turnStartedAt'>,
  now: number,
) {
  if (!state.clocks || !state.clockSide || state.turnStartedAt == null) return { clockSide: null }
  return {
    clocks: {
      ...state.clocks,
      [state.clockSide]: Math.max(0, state.clocks[state.clockSide] - (now - state.turnStartedAt)),
    },
    clockSide: null,
  }
}

/** Time left for `side` at `now`, counting the running clock down. */
export function clockRemaining(
  state: Pick<SparState, 'clocks' | 'clockSide' | 'turnStartedAt'>,
  side: SparColor,
  now: number,
) {
  if (!state.clocks) return null
  const running = state.clockSide === side && state.turnStartedAt != null
  return Math.max(0, state.clocks[side] - (running ? now - state.turnStartedAt! : 0))
}

export const useSparStore = create<SparState>((set, get) => ({
  status: 'idle',
  userColor: 'white',
  elo: startingSparElo(null),
  rated: false,
  origin: null,
  epoch: 0,
  outcome: null,
  eloChange: 0,
  reviewing: null,
  override: null,
  savedGameId: null,
  mistakesPosted: null,
  reviewSettled: false,
  timeControlSeconds: readTimeControl(),
  setTimeControl: (seconds) => {
    writeTimeControl(seconds)
    set({ timeControlSeconds: seconds })
  },
  clocks: null,
  turnStartedAt: null,
  clockSide: null,
  clockFen: null,
  chargeMove: (mover, now, fen) =>
    set((state) => {
      if (!state.clocks || state.turnStartedAt == null || state.status !== 'playing') return {}
      return {
        clocks: {
          ...state.clocks,
          [mover]: Math.max(0, state.clocks[mover] - (now - state.turnStartedAt)),
        },
        clockSide: mover === 'white' ? 'black' : 'white',
        clockFen: fen,
        turnStartedAt: now,
      }
    }),
  recordSaved: (gameId) => set({ savedGameId: gameId }),
  recordMistakes: (count) => set({ mistakesPosted: count }),
  settleReview: () => set({ reviewSettled: true }),
  reviewSaved: (userColor, epoch) =>
    set((state) => ({
      ...stoppedClocks(state, Date.now()),
      status: 'idle',
      userColor,
      outcome: null,
      eloChange: 0,
      reviewing: { userColor, epoch },
      savedGameId: null,
      mistakesPosted: null,
      reviewSettled: true,
    })),
  setOverride: (elo) => set({ override: elo == null ? null : clampSparRating(elo) }),
  start: ({ userColor, elo, rated, epoch, fen, origin = null }) => {
    const seconds = get().timeControlSeconds
    set({
      status: 'playing',
      userColor,
      elo: clampSparRating(elo),
      rated,
      origin,
      epoch,
      outcome: null,
      eloChange: 0,
      reviewing: null,
      savedGameId: null,
      mistakesPosted: null,
      reviewSettled: false,
      clocks: seconds == null ? null : { white: seconds * 1000, black: seconds * 1000 },
      clockSide: seconds == null ? null : sideToMove(fen),
      clockFen: fen,
      turnStartedAt: Date.now(),
    })
  },
  finish: (outcome, username) => {
    const { status, elo, rated } = get()
    if (status !== 'playing') return
    let eloChange = 0
    if (rated) {
      const next = nextSparElo(elo, outcome.result)
      eloChange = next - elo
      const previous = readSparStrength(username)
      writeSparStrength(username, { elo: next, games: (previous?.games ?? 0) + 1 })
    }
    // The game is reviewed as soon as it ends, labelled You / Stockfish.
    set((state) => ({
      ...stoppedClocks(state, Date.now()),
      status: 'over',
      outcome,
      eloChange,
      reviewing: { userColor: state.userColor, epoch: state.epoch },
    }))
  },
  markUnrated: () => set({ rated: false }),
  close: ({ review = false } = {}) =>
    set((state) => ({
      ...stoppedClocks(state, Date.now()),
      status: 'idle',
      outcome: null,
      eloChange: 0,
      reviewing:
        review || state.status === 'over'
          ? { userColor: state.userColor, epoch: state.epoch }
          : null,
    })),
}))

/** True while a sparring game is in progress and engine output must stay hidden. */
export function useIsSparring() {
  return useSparStore((state) => state.status === 'playing')
}
