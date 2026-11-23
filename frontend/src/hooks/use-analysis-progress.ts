import { useEffect, useState } from 'react'

import { estimateRate, type RateEstimate } from '@/lib/analysis/progress-rate'
import { useEngineStore } from '@/store/engine-store'

export type AnalysisProgress = RateEstimate & {
  active: boolean
  completed: number
  total: number
  /** 0-100, or null while the run has no known size. */
  percent: number | null
}

/**
 * Progress of the current batch analysis run, with a rate measured from this
 * run only. The engine owns the start time, so equal-size consecutive batches
 * and displays mounted partway through a run use the correct clock.
 */
export function useAnalysisProgress(): AnalysisProgress {
  const active = useEngineStore((state) => state.replayQueueActive)
  const completed = useEngineStore((state) => state.replayQueueCompleted)
  const total = useEngineStore((state) => state.replayQueueTotal)
  const startedAt = useEngineStore((state) => state.replayQueueStartedAt)

  const [, forceTick] = useState(0)

  // The counters only change when a position finishes, which at these depths
  // can be a minute apart — so the estimate needs its own clock to count down.
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [active])

  const elapsedMs = startedAt == null ? 0 : Math.max(0, Date.now() - startedAt)
  const rate = estimateRate({ completed, total, elapsedMs })

  return {
    ...rate,
    active,
    completed,
    total,
    percent: total > 0 ? Math.min(100, (completed / total) * 100) : null,
  }
}
