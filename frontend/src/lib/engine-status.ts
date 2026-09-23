import type { AnalysisMode } from '@/lib/stockfish/analysis-policy'

function modeLabel(mode: AnalysisMode | null | undefined) {
  if (mode === 'quick') return 'Quick analysis'
  if (mode === 'deep') return 'Deep analysis'
  if (mode === 'background') return 'Line analysis'
  return 'Analysis'
}

export function getEngineStatusMessage({
  activeMode,
  currentDepth,
  enabled,
  error,
  hasAttempted,
  isLoadingNnue,
  isReady,
  isAnalyzing,
}: {
  activeMode?: AnalysisMode | null
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
    return 'Loading analysis model…'
  }

  if (isAnalyzing) {
    return currentDepth > 0
      ? `${modeLabel(activeMode)} d${currentDepth}…`
      : isReady
        ? `${modeLabel(activeMode)}…`
        : 'Starting analysis…'
  }

  if (isReady) {
    return currentDepth > 0 ? `Ready at depth ${currentDepth}.` : 'Analysis ready.'
  }

  if (!hasAttempted) {
    return 'Starting analysis…'
  }

  return 'Starting analysis…'
}
