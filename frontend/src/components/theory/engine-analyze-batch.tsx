import { Cpu, Pause, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { PanelError } from '@/components/ui/panel-error'
import { useAnalysisProgress } from '@/hooks/use-analysis-progress'
import { useImprovementPlan } from '@/hooks/use-improvement'
import { describeEngineActivity, type EngineActivity } from '@/lib/analysis/engine-activity'
import { describePhaseSkew, summarizePhaseCoverage } from '@/lib/analysis/phase-coverage'
import { formatDuration } from '@/lib/analysis/progress-rate'
import { GAME_REVIEW_DEPTH } from '@/lib/analysis/review-depth'
import { api } from '@/lib/api'
import {
  readAutopilotPreference,
  writeAutopilotPreference,
} from '@/components/theory/autopilot-preference'
import { getReplayTimedOutFens, isReplayTimedOutFen, useEngineStore } from '@/store/engine-store'

type UnanalyzedFenResponse = {
  fens: string[]
  fen_depths?: Record<string, number>
  candidate_count?: number
  analyzed_count?: number
  missing_count?: number
  limit?: number
  min_depth?: number
  min_user_rating?: number
  selection_strategy?: string
  selected_decision_pairs_by_phase?: Record<string, number>
}

const AUTOPILOT_BATCH_LIMIT = 24
const AUTOPILOT_INTERVAL_MS = 30_000
// Two quiet cycles is a minute — long enough for a pending upload to land,
// short enough that a browser with nothing to contribute stops pretending.
const MAX_IDLE_BATCHES = 2
// Drawn at full height before the counts arrive, so the block does not grow
// into the page once they do.
const PENDING_PHASE_ROWS = [
  { phase: 'opening', label: 'Opening', analyzed: 0, share: 0 },
  { phase: 'middlegame', label: 'Middlegame', analyzed: 0, share: 0 },
  { phase: 'endgame', label: 'Endgame', analyzed: 0, share: 0 },
]

export function formatSelectedPairCounts(counts?: Record<string, number>): string | null {
  if (!counts) return null
  const phases = ['endgame', 'middlegame', 'opening']
  const parts = phases
    .filter((phase) => (counts[phase] ?? 0) > 0)
    .map((phase) => `${counts[phase]} ${phase}`)
  const total = phases.reduce((sum, phase) => sum + (counts[phase] ?? 0), 0)
  if (total === 0) return null
  return `Next up: ${parts.join(', ')} position${total === 1 ? '' : 's'}.`
}

/** The background crawler's last store, polled so a stall shows within a minute. */
function useEngineActivity() {
  return useQuery({
    queryKey: ['analysis-activity'],
    queryFn: async ({ signal }) =>
      (await api.get<EngineActivity>('/api/analysis/activity', { signal })).data,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

export function EngineAnalyzeBatch({
  color,
  timeClass,
  username,
}: {
  color: 'white' | 'black' | 'both'
  timeClass: string | null
  username: string
}) {
  const [coverage, setCoverage] = useState<UnanalyzedFenResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [browserAnalysisEnabled, setBrowserAnalysisEnabled] = useState(readAutopilotPreference)
  const [browserAnalysisFailures, setBrowserAnalysisFailures] = useState(0)
  // The server lists work this browser cannot take on: positions it has
  // already searched this session but not yet uploaded, or ones an older
  // import never recorded as finished games. Asking again is free but endless,
  // so allow the upload a couple of cycles to land and then stop and say so.
  const [idleBatches, setIdleBatches] = useState(0)
  const queueReplayAnalysis = useEngineStore((state) => state.queueReplayAnalysis)
  const stop = useEngineStore((state) => state.stop)
  const completed = useEngineStore((state) => state.replayQueueCompleted)
  const total = useEngineStore((state) => state.replayQueueTotal)
  const active = useEngineStore((state) => state.replayQueueActive)
  const progressLabel = active
    ? `Analyzing ${Math.min(completed + 1, total)} of ${total}`
    : total > 0
      ? `${completed} of ${total} analyzed this run`
      : null
  const stalled = idleBatches >= MAX_IDLE_BATCHES
  const analysisStatus = stalled
    ? 'Paused while finished analysis uploads. Start again in a minute.'
    : browserAnalysisEnabled || active
      ? 'Analyzing…'
      : coverage?.missing_count === 0
        ? 'All positions analyzed.'
        : null
  const coveragePercent =
    coverage?.candidate_count && coverage.analyzed_count != null
      ? Math.round((coverage.analyzed_count / coverage.candidate_count) * 100)
      : 0
  const nextBatchLabel = formatSelectedPairCounts(coverage?.selected_decision_pairs_by_phase)
  const progress = useAnalysisProgress()
  // Same query key as the trainer's unfiltered plan, so this is a cache read
  // rather than a second trip for numbers the server already computed.
  const plan = useImprovementPlan({ username, color, timeClass })
  const activity = useEngineActivity()
  const decisions = plan.data?.summary
  const phaseCoverage = decisions ? summarizePhaseCoverage(decisions.analyzed_by_phase) : null
  const phaseSkew = phaseCoverage ? describePhaseSkew(phaseCoverage) : null
  // Project this run's measured rate onto everything still outstanding. It is
  // a big, unwelcome number, and that is the point: it is what decides whether
  // to crawl the library or just review the games you care about.
  const remaining = coverage?.missing_count ?? 0
  const libraryEta =
    progress.perMinute && progress.perMinute > 0 && remaining > 0
      ? formatDuration((remaining / progress.perMinute) * 60)
      : null

  async function queueNextImportedGameBatch(signal: AbortSignal) {
    const response = await api.post<UnanalyzedFenResponse>(
      '/api/games/unanalyzed-fens',
      {
        exclude_fens: getReplayTimedOutFens(),
      },
      {
        signal,
        params: {
          username,
          color,
          time_class: timeClass ?? undefined,
          min_depth: GAME_REVIEW_DEPTH,
          limit: AUTOPILOT_BATCH_LIMIT,
        },
      },
    )
    if (signal.aborted) return { queuedCount: 0, offered: 0 }
    setCoverage(response.data)
    setError(null)
    // Skip FENs that timed out this session — re-queuing positions the device
    // can't analyze in time creates an infinite loop across batches.
    const fensToAnalyze = response.data.fens.filter((fen) => !isReplayTimedOutFen(fen))
    // What the engine actually took, not what was asked for. A position already
    // cached at this depth, or one that is already checkmate, is not work —
    // counting it as queued makes the batch look productive forever.
    const queuedCount = await queueReplayAnalysis(fensToAnalyze, {
      depth: GAME_REVIEW_DEPTH,
      depthByFen: response.data.fen_depths,
      background: true,
    })
    return { queuedCount, offered: fensToAnalyze.length }
  }

  useEffect(() => {
    writeAutopilotPreference(browserAnalysisEnabled)
  }, [browserAnalysisEnabled])

  useEffect(() => {
    let cancelled = false
    void api
      .get<UnanalyzedFenResponse>('/api/games/unanalyzed-fens', {
        params: {
          username,
          color,
          time_class: timeClass ?? undefined,
          min_depth: GAME_REVIEW_DEPTH,
          limit: AUTOPILOT_BATCH_LIMIT,
        },
      })
      .then((response) => {
        if (!cancelled) setCoverage(response.data)
      })
      .catch(() => {
        // Coverage is supporting context; the start action reports actionable
        // failures if analysis itself cannot run.
      })
    return () => {
      cancelled = true
    }
  }, [color, timeClass, username])

  useEffect(() => {
    if (!browserAnalysisEnabled) return
    if (browserAnalysisFailures >= 3) return
    if (idleBatches >= MAX_IDLE_BATCHES) {
      setBrowserAnalysisEnabled(false)
      return
    }

    const controller = new AbortController()
    let running = false
    const tick = () => {
      if (running) return
      if (active) return
      // A hidden tab takes no new batch: the one in hand finishes, and the
      // next waits until somebody can see the page again.
      if (typeof document !== 'undefined' && document.hidden) return

      running = true
      void queueNextImportedGameBatch(controller.signal)
        .then(({ queuedCount, offered }) => {
          if (controller.signal.aborted) return
          setBrowserAnalysisFailures(0)
          if (queuedCount > 0) {
            setIdleBatches(0)
            return
          }
          if (offered === 0) {
            // Nothing left to do at all.
            setBrowserAnalysisEnabled(false)
            setIdleBatches(0)
            return
          }
          setIdleBatches((count) => count + 1)
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setBrowserAnalysisFailures((count) => count + 1)
          setError('Analysis stopped after an error. Start it again to retry.')
        })
        .finally(() => {
          running = false
        })
    }

    tick()
    const intervalId = window.setInterval(tick, AUTOPILOT_INTERVAL_MS)
    return () => {
      controller.abort()
      window.clearInterval(intervalId)
    }
  }, [
    active,
    browserAnalysisEnabled,
    browserAnalysisFailures,
    color,
    idleBatches,
    queueReplayAnalysis,
    timeClass,
    username,
  ])

  const activityLine = activity.data ? describeEngineActivity(activity.data) : null

  return (
    <div className="analysis-batch">
      {/* Reserved line: the status lands with the request and must not push
          the meter down when it does. */}
      <p className="engine-activity" data-tone={activityLine?.tone}>
        {activityLine?.text ?? '\u00a0'}
      </p>
      {coverage?.candidate_count != null && coverage.analyzed_count != null ? (
        <div className="coverage-meter">
          <div className="coverage-meter__head">
            <span className="coverage-meter__value">{coveragePercent}%</span>
            <span className="coverage-meter__caption">
              <strong>
                {coverage.analyzed_count.toLocaleString()} of{' '}
                {coverage.candidate_count.toLocaleString()}
              </strong>{' '}
              positions analyzed, from games you played at rating {coverage.min_user_rating ?? 1000}{' '}
              and up.
            </span>
          </div>
          <div
            aria-label="Imported game analysis coverage"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={coveragePercent}
            className="coverage-meter__track"
            role="progressbar"
          >
            {/* A run that has barely started still deserves a visible sliver. */}
            <i style={{ width: `${coveragePercent > 0 ? Math.max(coveragePercent, 1.5) : 0}%` }} />
          </div>
          {remaining > 0 ? (
            <p className="coverage-meter__next">
              {libraryEta
                ? `${remaining.toLocaleString()} positions left, about ${libraryEta} at this rate. Reviewing one game from the Library is much faster.`
                : nextBatchLabel}
            </p>
          ) : null}
        </div>
      ) : null}
      {plan.error ? (
        <PanelError error={plan.error} onRetry={() => void plan.refetch()} what="phase coverage" />
      ) : (
        <div aria-busy={phaseCoverage ? undefined : true} className="phase-coverage">
          <h4 className="phase-coverage__title">
            Analyzed decisions by phase
            <span className="phase-coverage__total">
              {decisions
                ? `${decisions.analyzed_decisions.toLocaleString()} of ${decisions.total_decisions.toLocaleString()}`
                : null}
            </span>
          </h4>
          {/* The rows are drawn before the numbers arrive so the block stands
              at its final height from the start and the buttons below it never
              move. Labels are the content; the counts fill in. */}
          <ul className="phase-coverage__rows">
            {(phaseCoverage?.rows ?? PENDING_PHASE_ROWS).map((row) => (
              <li className="phase-coverage__row" key={row.phase}>
                <span className="phase-coverage__label">{row.label}</span>
                <span className="phase-coverage__bar">
                  {/* Any analysis at all deserves a visible mark; the count
                      beside it carries the real precision. */}
                  <i style={{ width: `${row.share > 0 ? Math.max(row.share * 100, 1.5) : 0}%` }} />
                </span>
                <span className="phase-coverage__count">
                  {phaseCoverage ? row.analyzed.toLocaleString() : null}
                </span>
                <span className="phase-coverage__share">
                  {phaseCoverage ? `${Math.round(row.share * 100)}%` : null}
                </span>
              </li>
            ))}
          </ul>
          {/* Reserved either way, so balancing out a phase does not pull the
              panel below it upward. */}
          <p className="phase-coverage__note">{phaseSkew}</p>
        </div>
      )}
      <div className="analysis-batch__actions">
        <Button
          onClick={() => {
            setBrowserAnalysisFailures(0)
            setIdleBatches(0)
            setBrowserAnalysisEnabled((enabled) => !enabled)
          }}
          type="button"
          variant={browserAnalysisEnabled ? 'default' : 'primary'}
        >
          {browserAnalysisEnabled ? <Pause size={14} /> : <Cpu size={14} />}
          <span>{browserAnalysisEnabled ? 'Pause analysis' : 'Analyze my games'}</span>
        </Button>
        {active ? (
          <Button onClick={stop} type="button" variant="ghost">
            <X size={14} />
            <span>Cancel</span>
          </Button>
        ) : null}
      </div>
      {active && progressLabel ? (
        <div className="analysis-batch__status">{progressLabel}</div>
      ) : analysisStatus ? (
        <div className="analysis-batch__status">{analysisStatus}</div>
      ) : null}
      {error ? <div className="callout callout--error">{error}</div> : null}
    </div>
  )
}
