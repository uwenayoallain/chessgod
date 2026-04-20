import { Loader2 } from 'lucide-react'

import { useEngineStore } from '@/store/engine-store'

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value))
}

export function EvaluationProgress() {
  const isAnalyzing = useEngineStore((state) => state.isAnalyzing)
  const replayQueueActive = useEngineStore((state) => state.replayQueueActive)
  const replayQueueCompleted = useEngineStore((state) => state.replayQueueCompleted)
  const replayQueueTotal = useEngineStore((state) => state.replayQueueTotal)

  if (!isAnalyzing && !replayQueueActive) {
    return null
  }

  const hasReplayProgress = replayQueueTotal > 0
  const percentage = hasReplayProgress ? clampPercent((replayQueueCompleted / replayQueueTotal) * 100) : 20
  const label = hasReplayProgress
    ? `Evaluating line ${Math.min(replayQueueCompleted, replayQueueTotal)}/${replayQueueTotal}`
    : 'Evaluating current position'

  return (
    <div className="evaluation-bar">
      <div className="evaluation-bar__info">
        <Loader2 className="spin" size={12} />
        <span className="evaluation-bar__label">{label}</span>
      </div>
      <div className="progress" aria-valuemax={100} aria-valuemin={0} aria-valuenow={hasReplayProgress ? percentage : undefined} role="progressbar">
        <div
          className={`progress__value${hasReplayProgress ? '' : ' progress__value--indeterminate'}`}
          style={hasReplayProgress ? { width: `${percentage}%` } : undefined}
        />
      </div>
    </div>
  )
}
