import { create } from 'zustand'

import {
  clampSparRating,
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
  start: (options: { userColor: SparColor; elo: number; rated: boolean; epoch: number }) => void
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

export const useSparStore = create<SparState>((set, get) => ({
  status: 'idle',
  userColor: 'white',
  elo: startingSparElo(null),
  rated: false,
  epoch: 0,
  outcome: null,
  eloChange: 0,
  reviewing: null,
  override: null,
  setOverride: (elo) => set({ override: elo == null ? null : clampSparRating(elo) }),
  start: ({ userColor, elo, rated, epoch }) =>
    set({
      status: 'playing',
      userColor,
      elo: clampSparRating(elo),
      rated,
      epoch,
      outcome: null,
      eloChange: 0,
      reviewing: null,
    }),
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
    set({ status: 'over', outcome, eloChange })
  },
  markUnrated: () => set({ rated: false }),
  close: ({ review = false } = {}) =>
    set((state) => ({
      status: 'idle',
      outcome: null,
      eloChange: 0,
      reviewing: review ? { userColor: state.userColor, epoch: state.epoch } : null,
    })),
}))

/** True while a sparring game is in progress and engine output must stay hidden. */
export function useIsSparring() {
  return useSparStore((state) => state.status === 'playing')
}
