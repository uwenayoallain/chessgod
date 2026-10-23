import type { ChallengeBoard } from './types'

// Imported games older than this may be missing the latest ones.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Whether the board may be missing games: the challenges count only what has
 * been imported, so a library last synced before today undercounts the week.
 */
export function challengesStale(board: ChallengeBoard, now: Date): boolean {
  if (!board.latest_game) return true
  return now.getTime() - new Date(board.latest_game).getTime() > STALE_AFTER_MS
}
