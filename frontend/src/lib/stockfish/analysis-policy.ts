export type AnalysisMode = 'quick' | 'standard' | 'deep' | 'background'
export type AnalysisSource = 'interactive' | 'replay'

export type AnalysisJob = {
  fen: string
  depth: number
  multiPV: number
  mode: AnalysisMode
  source: AnalysisSource
  /** A time limit for the search, in milliseconds; none when absent. */
  movetime?: number
}

/**
 * How long a look at the board may search before it stops on its own.
 *
 * The board asks for depth 26-30, and on a laptop with two engine threads (and
 * often a crawler beside them) depth 30 never arrived: the search ran to its
 * 90s timeout on every position stepped to, holding two cores at full boost
 * the whole time. Lines show from the first iteration and reach depth 20 in
 * about a second, so twelve seconds is plenty for a look; asking for a deep
 * look is what buys the long search.
 */
export const INTERACTIVE_MOVETIME_MS = 12_000
export const DEEP_MOVETIME_MS = 45_000

export type ReplayProgress = {
  completed: number
  total: number
}

export function chooseEngineMode({
  requestedDepth,
  source,
  stable,
  deep = false,
}: {
  requestedDepth: number
  source: AnalysisSource
  stable: boolean
  deep?: boolean
}): Pick<AnalysisJob, 'depth' | 'mode' | 'multiPV' | 'movetime'> {
  if (source === 'replay') {
    return { depth: requestedDepth, mode: 'background', multiPV: 1 }
  }

  if (deep) {
    return { depth: requestedDepth, mode: 'deep', multiPV: 3, movetime: DEEP_MOVETIME_MS }
  }

  if (!stable) {
    return {
      depth: Math.min(18, requestedDepth),
      mode: 'quick',
      multiPV: 1,
      movetime: INTERACTIVE_MOVETIME_MS,
    }
  }

  return {
    depth: requestedDepth,
    mode: 'standard',
    multiPV: 2,
    movetime: INTERACTIVE_MOVETIME_MS,
  }
}

export function enqueueAnalysisJob(queue: AnalysisJob[], item: AnalysisJob): AnalysisJob[] {
  if (item.source === 'interactive') {
    const withoutStaleInteractive = queue.filter((queued) => queued.source !== 'interactive')
    return [item, ...withoutStaleInteractive]
  }

  const withoutDuplicateReplay = queue.filter(
    (queued) => !(queued.source === 'replay' && queued.fen === item.fen),
  )
  return [...withoutDuplicateReplay, item]
}

export function completeReplayJob(progress: ReplayProgress) {
  const completed = Math.min(progress.total, progress.completed + 1)

  return {
    active: completed < progress.total,
    completed,
    total: progress.total,
  }
}

export function handleReplayTimeout({
  attempts,
  maxRetries,
  reachedDepth,
}: {
  attempts: number
  maxRetries: number
  reachedDepth: number
}) {
  if (reachedDepth > 0) {
    return { complete: true, retry: false }
  }

  return {
    complete: attempts >= maxRetries,
    retry: attempts < maxRetries,
  }
}

export function buildUciSearchCommands({
  depth,
  fen,
  hash,
  movetime,
  multiPV,
  threads,
}: {
  depth: number
  fen: string
  hash?: number
  movetime?: number
  multiPV: number
  threads?: number
}) {
  const commands: string[] = []
  if (threads != null) commands.push(`setoption name Threads value ${threads}`)
  if (hash != null) commands.push(`setoption name Hash value ${hash}`)
  commands.push(`setoption name MultiPV value ${multiPV}`)
  commands.push(`position fen ${fen}`)
  // Stockfish stops at whichever limit it reaches first.
  const timeLimit =
    movetime != null && Number.isFinite(movetime) && movetime > 0
      ? ` movetime ${Math.round(movetime)}`
      : ''
  commands.push(`go depth ${depth}${timeLimit}`)
  return commands
}
