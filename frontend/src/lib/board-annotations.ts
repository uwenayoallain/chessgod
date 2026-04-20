export function shouldShowBoardAnnotations({
  hasActiveGame,
  hasSelectedOpening,
}: {
  hasActiveGame: boolean
  hasSelectedOpening: boolean
}) {
  return hasActiveGame || hasSelectedOpening
}
