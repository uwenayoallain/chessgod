export function shouldShowBoardAnnotations({
  hasActiveGame,
  hasSelectedOpening,
  isSolvingDrill = false,
}: {
  hasActiveGame: boolean
  hasSelectedOpening: boolean
  isSolvingDrill?: boolean
}) {
  // A drill asks the player to find the move. Annotating the board while they are
  // still looking hands them the answer.
  if (isSolvingDrill) return false
  return hasActiveGame || hasSelectedOpening
}
