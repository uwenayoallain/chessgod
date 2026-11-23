export function retainDeeperAnalysis<T extends { depth: number }>(
  existing: T | undefined,
  incoming: T,
): T {
  return existing && existing.depth > incoming.depth ? existing : incoming
}

type AnalysisLine = {
  depth: number
  multipv: number
  pv: string[]
}

type MergeableAnalysis = {
  depth: number
  bestMove: string | null
  lines: AnalysisLine[]
  persisted?: boolean
}

/**
 * Merge per-variation engine snapshots without throwing away useful lines.
 *
 * A deeper rank-one search and a shallower MultiPV search are both useful: the
 * former is the trusted primary evaluation, while the latter supplies legal
 * alternatives for coaching. Keeping one whole snapshot based only on its
 * aggregate depth either loses those alternatives or causes the same search to
 * run forever.
 */
export function mergeEngineAnalysis<T extends MergeableAnalysis>(
  existing: T | undefined,
  incoming: T,
): T {
  if (!existing) return incoming

  const byVariation = new Map<number, AnalysisLine>()
  for (const line of existing.lines) byVariation.set(line.multipv, line)
  for (const line of incoming.lines) {
    const previous = byVariation.get(line.multipv)
    if (!previous || line.depth >= previous.depth) byVariation.set(line.multipv, line)
  }

  // A move can change rank between searches. Keep its preferred rank once;
  // duplicates are not independent alternatives and must not satisfy MultiPV
  // coverage or be uploaded as separate coaching evidence.
  const seenMoves = new Set<string>()
  const lines = [...byVariation.values()]
    .sort((left, right) => left.multipv - right.multipv)
    .filter((line) => {
      const move = line.pv[0]
      if (!move || seenMoves.has(move)) return false
      seenMoves.add(move)
      return true
    })
  if (
    lines.length === existing.lines.length &&
    lines.every((line, index) => line === existing.lines[index])
  ) {
    return existing
  }
  const primary = lines.find((line) => line.multipv === 1)
  return {
    ...existing,
    ...incoming,
    bestMove: primary?.pv[0] ?? incoming.bestMove ?? existing.bestMove,
    depth: primary?.depth ?? Math.max(existing.depth, incoming.depth),
    lines,
    // The upload hook skips persisted snapshots. A mixed snapshot is only
    // persisted when every retained line came from a persisted source.
    persisted: lines.every((line) =>
      incoming.lines.includes(line) ? incoming.persisted === true : existing.persisted === true,
    ),
  }
}

export function needsEngineAnalysis(
  cachedDepth: number | null,
  requestedDepth: number,
  force = false,
  cachedMultiPV = 1,
  requestedMultiPV = 1,
) {
  if (force) {
    return true
  }

  if (cachedDepth == null) {
    return true
  }

  return cachedDepth < requestedDepth || cachedMultiPV < requestedMultiPV
}
