type ReplayMove = {
  ply: number
  san: string
  uci: string
  fen: string
}

type TheoryCompareResponse = {
  master_moves: Array<{ san: string; uci?: string | null }>
}

const theoryCache = new Map<string, TheoryCompareResponse | null>()

export function clearTheoryCache() {
  theoryCache.clear()
}

export async function fetchCachedTheoryCompare(
  fen: string,
  fetchTheoryCompare: (fen: string) => Promise<TheoryCompareResponse | null>,
) {
  if (theoryCache.has(fen)) {
    return theoryCache.get(fen) ?? null
  }

  const result = await fetchTheoryCompare(fen)
  theoryCache.set(fen, result)
  return result
}

export type BookPliesResult = {
  plies: number[]
  hadErrors: boolean
}

export async function prefetchBookPlies({
  replayMoves,
  fenHistory,
  fetchTheoryCompare,
}: {
  replayMoves: ReplayMove[]
  fenHistory: string[]
  fetchTheoryCompare: (fen: string) => Promise<TheoryCompareResponse | null>
}): Promise<BookPliesResult> {
  const bookPlies: number[] = []
  let hadErrors = false

  for (const move of replayMoves) {
    const parentFen = fenHistory[move.ply - 1]
    if (!parentFen) break

    const theoryData = await fetchCachedTheoryCompare(parentFen, fetchTheoryCompare)
    if (theoryData === null) {
      hadErrors = true
      break
    }
    if (!theoryData.master_moves.length) break

    const isBookMove = theoryData.master_moves.some(
      (candidate) => (candidate.uci && candidate.uci === move.uci) || candidate.san === move.san,
    )
    if (isBookMove) {
      bookPlies.push(move.ply)
    } else {
      break
    }
  }

  return { plies: bookPlies, hadErrors }
}
