export type AnalysisMode = 'quick' | 'standard' | 'deep' | 'background'
export type AnalysisSource = 'interactive' | 'replay'

export type AnalysisJob = {
  fen: string
  depth: number
  multiPV: number
  mode: AnalysisMode
  source: AnalysisSource
}

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
}): Pick<AnalysisJob, 'depth' | 'mode' | 'multiPV'> {
  if (source === 'replay') {
    return { depth: requestedDepth, mode: 'background', multiPV: 1 }
  }

  if (deep) {
    return { depth: requestedDepth, mode: 'deep', multiPV: 3 }
  }

  if (!stable) {
    return { depth: Math.min(18, requestedDepth), mode: 'quick', multiPV: 1 }
  }

  return { depth: requestedDepth, mode: 'standard', multiPV: 2 }
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
  multiPV,
  threads,
}: {
  depth: number
  fen: string
  hash?: number
  multiPV: number
  threads?: number
}) {
  const commands: string[] = []
  if (threads != null) commands.push(`setoption name Threads value ${threads}`)
  if (hash != null) commands.push(`setoption name Hash value ${hash}`)
  commands.push(`setoption name MultiPV value ${multiPV}`)
  commands.push(`position fen ${fen}`)
  commands.push(`go depth ${depth}`)
  return commands
}
