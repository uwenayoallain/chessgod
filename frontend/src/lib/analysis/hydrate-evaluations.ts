import { api } from '@/lib/api'
import { GAME_REVIEW_DEPTH, MIN_TRUSTED_DEPTH } from '@/lib/analysis/review-depth'
import { useEngineStore, type PersistedEngineAnalysis } from '@/store/engine-store'

/** The evaluations endpoint refuses more than this many FENs a request. */
const EVALUATION_BATCH = 100

function hasStoredLine(fen: string) {
  return Boolean(useEngineStore.getState().analysisByFen[fen]?.lines?.[0]?.pv?.length)
}

/**
 * Load the stored evaluations for positions a trainer is about to ask, so the
 * line shown once an answer is resolved ("What follows") is already in the
 * engine cache and needs no search. Every drill and Blunder Check position was
 * searched by the crawler before it could become a question, so this is almost
 * always a cache fill rather than engine work.
 *
 * Positions already cached with a line are skipped. Failures are swallowed: the
 * continuation falls back to a browser search, so a missing row costs time, not
 * correctness. Resolves with the FENs the server returned a row for.
 */
export async function hydrateEvaluationsForFens(
  fens: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const missing = [...new Set(fens.filter(Boolean))].filter((fen) => !hasStoredLine(fen))
  if (!missing.length) return []

  const chunks: string[][] = []
  for (let start = 0; start < missing.length; start += EVALUATION_BATCH) {
    chunks.push(missing.slice(start, start + EVALUATION_BATCH))
  }

  const found: string[] = []
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const response = await api.get<Record<string, PersistedEngineAnalysis>>(
          '/api/analysis/evaluations',
          {
            params: {
              fens: chunk.join(','),
              min_depth: MIN_TRUSTED_DEPTH,
              prefer_depth: GAME_REVIEW_DEPTH,
            },
            signal,
          },
        )
        if (signal?.aborted) return
        const data = response?.data
        if (!data || typeof data !== 'object') return
        useEngineStore.getState().hydrateAnalysisCache(data)
        found.push(...Object.keys(data))
      } catch {
        // Cancelled, offline or refused: the continuation searches instead.
      }
    }),
  )
  return found
}
