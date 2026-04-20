export function getEngineStatusMessage({
  currentDepth,
  enabled,
  error,
  hasAttempted,
  isLoadingNnue,
  isReady,
  isAnalyzing,
}: {
  currentDepth: number
  enabled: boolean
  error: string | null
  hasAttempted: boolean
  isLoadingNnue: boolean
  isReady: boolean
  isAnalyzing: boolean
}) {
  if (error) {
    return error
  }

  if (!enabled) {
    return 'Engine off.'
  }

  if (isLoadingNnue) {
    return 'Loading NNUE…'
  }

  if (isAnalyzing) {
    return currentDepth > 0 ? `Analyzing depth ${currentDepth}…` : isReady ? 'Analyzing current position…' : 'Starting Stockfish…'
  }

  if (isReady) {
    return currentDepth > 0 ? `Engine ready at depth ${currentDepth}.` : 'Engine ready.'
  }

  if (!hasAttempted) {
    return 'Starting Stockfish…'
  }

  return 'Starting Stockfish…'
}
