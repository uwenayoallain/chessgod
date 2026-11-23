import { STARTING_FEN } from '@/store/app-store'

/** The board position with no moves played, however the FEN is spelled. */
function isInitialPosition(fen: string): boolean {
  // Compare placement + side + castling + en passant only: the half-move and
  // full-move counters are not part of what makes this the starting position,
  // and the app stores the FEN without them.
  const key = (value: string) => value.trim().split(/\s+/).slice(0, 4).join(' ')
  return key(fen) === key(STARTING_FEN)
}

/**
 * Whether a position is worth starting an engine on by itself.
 *
 * The board sits at the starting position until a game or a line is loaded, and
 * the auto-analyse effect fires on every `currentFen` change — so simply opening
 * the app began a full-depth search of the opening position. It is the one
 * position on the board whose evaluation is already known, is identical for
 * every user and every game, and belongs to no decision anybody made: the first
 * move is an opening choice, not a mistake. Searching it costs the user a core
 * the moment the page loads and can teach nothing.
 *
 * This governs the *automatic* search only. Asking for it explicitly — pressing
 * analyse, or stepping onto the position during a review — still works.
 */
export function shouldAutoAnalyze(fen: string | null | undefined): boolean {
  if (!fen) return false
  return !isInitialPosition(fen)
}
