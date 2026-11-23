type ReplayMove = {
  ply: number
  san: string
  uci: string
  fen: string
}

type TheoryCompareResponse = {
  master_moves: Array<{ san: string; uci?: string | null }>
}

export const MAX_THEORY_CACHE_ENTRIES = 500

const theoryCache = new Map<string, TheoryCompareResponse | null>()

export function clearTheoryCache() {
  theoryCache.clear()
}

export async function fetchCachedTheoryCompare(
  fen: string,
  fetchTheoryCompare: (fen: string) => Promise<TheoryCompareResponse | null>,
) {
  if (theoryCache.has(fen)) {
    const cached = theoryCache.get(fen) ?? null
    theoryCache.delete(fen)
    theoryCache.set(fen, cached)
    return cached
  }

  const result = await fetchTheoryCompare(fen)
  if (theoryCache.has(fen)) {
    theoryCache.delete(fen)
  } else if (theoryCache.size >= MAX_THEORY_CACHE_ENTRIES) {
    const oldestKey = theoryCache.keys().next().value
    if (oldestKey !== undefined) {
      theoryCache.delete(oldestKey)
    }
  }
  theoryCache.set(fen, result)
  return result
}

export type BookPliesResult = {
  plies: number[]
  hadErrors: boolean
}

/** How many of the opening's positions are asked for before the first answer is read. */
export const BOOK_PREFETCH_PLIES = 24
/** How many theory requests are in flight at once while prefetching. */
export const BOOK_PREFETCH_BATCH = 6

/**
 * The plies of a game played from the master book, from the first move until
 * the first one that is not.
 *
 * The first `BOOK_PREFETCH_PLIES` parent positions are asked for
 * `BOOK_PREFETCH_BATCH` at a time and then read in order: one request after
 * another, a game twenty plies deep in book waited on twenty round trips
 * through the tunnel. A batch is read before the next is asked for, so a game
 * that leaves the book on move three costs one batch, not twenty-four
 * requests. Past the prefetch the scan goes one position at a time, since few
 * games are still in book there. `isStale` ends the scan between requests,
 * for a caller that has moved on to another game.
 */
export async function prefetchBookPlies({
  replayMoves,
  fenHistory,
  fetchTheoryCompare,
  isStale,
}: {
  replayMoves: ReplayMove[]
  fenHistory: string[]
  fetchTheoryCompare: (fen: string) => Promise<TheoryCompareResponse | null>
  isStale?: () => boolean
}): Promise<BookPliesResult> {
  const bookPlies: number[] = []
  let hadErrors = false
  const stale = () => isStale?.() === true

  for (let start = 0; start < replayMoves.length;) {
    if (stale()) break
    const size = start < BOOK_PREFETCH_PLIES ? BOOK_PREFETCH_BATCH : 1
    const batch = replayMoves.slice(start, start + size)
    const parents = batch.map((move) => fenHistory[move.ply - 1])
    const answers = await Promise.all(
      parents.map((parentFen) =>
        parentFen ? fetchCachedTheoryCompare(parentFen, fetchTheoryCompare) : Promise.resolve(null),
      ),
    )
    if (stale()) break
    for (let index = 0; index < batch.length; index += 1) {
      const move = batch[index]
      if (!parents[index]) return { plies: bookPlies, hadErrors }
      const theoryData = answers[index]
      if (theoryData === null) {
        hadErrors = true
        return { plies: bookPlies, hadErrors }
      }
      if (!theoryData.master_moves.length) return { plies: bookPlies, hadErrors }

      const isBookMove = theoryData.master_moves.some(
        (candidate) => (candidate.uci && candidate.uci === move.uci) || candidate.san === move.san,
      )
      if (!isBookMove) return { plies: bookPlies, hadErrors }
      bookPlies.push(move.ply)
    }
    start += batch.length
  }

  return { plies: bookPlies, hadErrors }
}
