import { isLegalUciMove, getLatestMoveSquares } from './board-guidance'

import type { TheoryMove } from '@/hooks/use-theory'

/**
 * The master moves worth drawing on the board, by destination square.
 *
 * The Theory panel already lists them, but a list beside a board asks the reader
 * to translate "Nf3" into a square themselves. Marking the destination is the
 * whole point of having a board there.
 */
export type BookMarker = {
  square: string
  san: string
  /** 1 is the most played master move from this position. */
  rank: number
  /** Share of *all* master games from this position, not just the drawn ones. */
  share: number
  gameCount: number
}

export const BOOK_MARKER_LIMIT = 3

export function buildBookMarkers({
  masterMoves,
  fen,
  limit = BOOK_MARKER_LIMIT,
}: {
  masterMoves: TheoryMove[] | null | undefined
  fen: string
  limit?: number
}): Record<string, BookMarker> {
  if (!masterMoves?.length || !fen) return {}

  // The denominator is every master game from this position, including moves
  // too rare to draw. Re-normalising over the top three would inflate them into
  // looking like the whole book.
  const totalGames = masterMoves.reduce((sum, move) => sum + (move.game_count || 0), 0)
  if (totalGames <= 0) return {}

  const playable = masterMoves
    .filter((move) => move.uci && move.game_count > 0 && isLegalUciMove(fen, move.uci))
    .sort((a, b) => b.game_count - a.game_count)
    .slice(0, limit)

  const markers: Record<string, BookMarker> = {}
  playable.forEach((move, index) => {
    const squares = getLatestMoveSquares(move.uci)
    if (!squares) return
    const [, to] = squares
    // Two book moves can land on the same square (a capture and a quiet move).
    // The more popular one already sorted first, so never overwrite it.
    if (markers[to]) return
    markers[to] = {
      square: to,
      san: move.san,
      rank: index + 1,
      share: move.game_count / totalGames,
      gameCount: move.game_count,
    }
  })
  return markers
}

/** "48% of master games" — what the marker means, for its tooltip. */
export function bookMarkerTitle(marker: BookMarker): string {
  const percent =
    marker.share >= 0.01 ? Math.round(marker.share * 100) : (marker.share * 100).toFixed(1)
  return `${marker.san}: ${percent}% of master games (${marker.gameCount.toLocaleString()})`
}
