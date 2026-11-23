export function shouldShowBoardAnnotations({
  hasActiveGame,
  hasSelectedOpening,
  hasSparringReview = false,
  isSolvingDrill = false,
}: {
  hasActiveGame: boolean
  hasSelectedOpening: boolean
  /** A finished game against the engine, still on the board and reviewed. */
  hasSparringReview?: boolean
  isSolvingDrill?: boolean
}) {
  // A drill asks the player to find the move. Annotating the board while they are
  // still looking hands them the answer.
  if (isSolvingDrill) return false
  // A game against the engine is nobody's library game, but once it is over
  // its review grades every move like any other: the badges belong on the board.
  return hasActiveGame || hasSelectedOpening || hasSparringReview
}
