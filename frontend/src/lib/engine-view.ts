import type { CachedEngineAnalysis } from '@/store/engine-store'
import type { UCIInfo } from './stockfish/uci'

export type CurrentEngineViewInput = {
  analysisByFen: Record<string, CachedEngineAnalysis>
  analyzedFen: string | null
  bestMove: string | null
  currentDepth: number
  currentFen: string
  lines: UCIInfo[]
}

export function selectCurrentEngineView({
  analysisByFen,
  analyzedFen,
  bestMove,
  currentDepth,
  currentFen,
  lines,
}: CurrentEngineViewInput) {
  if (analyzedFen === currentFen) {
    return {
      bestMove,
      currentDepth,
      lines,
    }
  }

  const cached = analysisByFen[currentFen]
  if (cached) {
    return {
      bestMove: cached.bestMove,
      currentDepth: cached.depth,
      lines: cached.lines,
    }
  }

  return {
    bestMove: null,
    currentDepth: 0,
    lines: [],
  }
}
