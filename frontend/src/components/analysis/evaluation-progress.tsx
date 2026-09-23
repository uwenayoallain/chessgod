import { useAnalysisProgress } from '@/hooks/use-analysis-progress'
import { formatDuration } from '@/lib/analysis/progress-rate'
import { useEngineStore } from '@/store/engine-store'

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value))
}

export function EvaluationProgress() {
  const isAnalyzing = useEngineStore((state) => state.isAnalyzing)
  const kind = useEngineStore((state) => state.replayQueueKind)
  const progress = useAnalysisProgress()

  const active = isAnalyzing || progress.active
  const hasReplayProgress = progress.total > 0
  const percentage = hasReplayProgress ? clampPercent(progress.percent ?? 0) : 20

  if (!active) return null

  const eta =
    progress.etaSeconds != null && progress.etaSeconds > 0
      ? ` · about ${formatDuration(progress.etaSeconds)} left`
      : ''
  // Say what the run is for: a bare count read as the app doing something
  // unexplained, when it was the review of the game just played.
  const what =
    kind === 'game'
      ? 'Reviewing this game'
      : kind === 'library'
        ? 'Analyzing your library'
        : 'Analyzing'
  const label = hasReplayProgress
    ? `${what}: ${progress.completed} of ${progress.total} positions${eta}`
    : 'Analyzing this position'

  return (
    <div className="evaluation-bar">
      <span>{label}</span>
      <div
        className="progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={hasReplayProgress ? percentage : undefined}
        role="progressbar"
      >
        <div
          className={`progress__value${hasReplayProgress ? '' : ' progress__value--indeterminate'}`}
          style={hasReplayProgress ? { width: `${percentage}%` } : undefined}
        />
      </div>
    </div>
  )
}
