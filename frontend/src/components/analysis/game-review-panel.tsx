import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { EvalGraph } from '@/components/analysis/eval-graph'
import { Emblem, Medal } from '@/components/training/trophies'
import { RetryMistakes, useIsRetrying, useRetryStore } from '@/components/analysis/retry-mistakes'
import { AnnotationIcon, annotationTitle } from '@/components/ui/annotation-icon'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import {
  annotationAtFen,
  describeLabel,
  formatCost,
  REVIEW_LABELS,
  reviewCoverage,
  reviewSide,
  sideAccuracy,
} from '@/lib/analysis/game-review'
import type { ReplayMoveAnnotation } from '@/lib/analysis/replay-annotations'
import { formatDuration } from '@/lib/analysis/progress-rate'
import { useAnalysisProgress } from '@/hooks/use-analysis-progress'
import { useAnalyzeLine } from '@/hooks/use-analyze-line'
import { postTrainingEvent, useApplyReward } from '@/hooks/use-training'
import { api } from '@/lib/api'
import { uciToSan } from '@/lib/chess-utils'
import { buildFullGameLine } from '@/lib/analysis/active-line'
import { explanationRequests, type MoveExplanation } from '@/lib/analysis/move-explanations'
import { retryItems } from '@/lib/analysis/retry'
import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'

function moveNumber(ply: number) {
  return `${Math.ceil(ply / 2)}${ply % 2 === 1 ? '.' : '…'}`
}

/**
 * Names what each costly move did — a hung piece, an allowed fork, a missed
 * mate — with the classifier the drills use, so a review says why a move was
 * bad and not only how much it cost. Asked once per set of judged moves.
 */
function useMoveExplanations(moves: ReplayMoveAnnotation[], fenHistory: string[]) {
  const analysisVersion = useEngineStore((state) => state.analysisVersion)
  const requests = useMemo(
    () =>
      explanationRequests({
        moves,
        analysisByFen: useEngineStore.getState().analysisByFen,
        fenHistory,
      }),
    // analysisVersion: the lines behind each move arrive after the move is graded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [moves, fenHistory, analysisVersion],
  )
  const { data } = useQuery({
    enabled: requests.length > 0,
    queryKey: ['move-explanations', requests],
    queryFn: async ({ signal }) =>
      (await api.post<MoveExplanation[]>('/api/analysis/explain', { items: requests }, { signal }))
        .data,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
  })
  return useMemo(() => new Map((data ?? []).map((item) => [item.ply, item])), [data])
}

function hash(text: string) {
  let value = 5381
  for (let i = 0; i < text.length; i += 1) value = ((value << 5) + value + text.charCodeAt(i)) | 0
  return (value >>> 0).toString(16)
}

// Shorter lines are positions studied on the board, not games.
const REVIEWED_GAME_MIN_MOVES = 20

/** A finished review is training: it earns XP once per game, however often it is reopened. */
function useReviewReward(moves: number, complete: boolean, fenHistory: string[]) {
  const username = useAppStore((state) => state.username)
  const applyReward = useApplyReward(username)
  const game = fenHistory.length ? hash(fenHistory.join('|')) : null
  // A retry branches off the game, which cuts the line short: not a new game.
  const retrying = useIsRetrying()
  useEffect(() => {
    if (retrying || !username || !complete || !game || moves < REVIEWED_GAME_MIN_MOVES) return
    void postTrainingEvent(username, 'game_reviewed', `review:${game}`).then((reward) =>
      applyReward(reward, 'Game reviewed'),
    )
  }, [applyReward, complete, game, moves, retrying, username])
}

/** Chess.com's "Retry": the player's own mistakes in this game, to find better. */
function RetryButton({
  annotations,
  fenHistory,
  side,
}: {
  annotations: ReplayMoveAnnotation[]
  fenHistory: string[]
  side: 'white' | 'black'
}) {
  const start = useRetryStore((state) => state.start)
  const items = useMemo(() => {
    const { nodes, currentNodeId } = useAppStore.getState()
    return retryItems(
      annotations,
      fenHistory,
      buildFullGameLine(nodes, currentNodeId).nodeIds,
      side,
    )
  }, [annotations, fenHistory, side])
  // A finished review ends on a medal: gold and clean when there is nothing to
  // retry, otherwise the mistakes waiting and the way into them.
  return (
    <div className="review-done" data-clean={!items.length || undefined}>
      <Medal earned emblem="magnifier" label="Review finished" progress={1} size={40} />
      <span className="review-done__text">
        <strong>Review finished</strong>
        <span className="muted">
          {items.length
            ? `${items.length} ${items.length === 1 ? 'mistake' : 'mistakes'} to try again.`
            : 'A clean game. Nothing to retry.'}
        </span>
      </span>
      {items.length ? (
        <Button
          onClick={() =>
            start({
              gameKey: hash(fenHistory.join('|')),
              items,
              returnNodeId: useAppStore.getState().currentNodeId,
            })
          }
          type="button"
          variant="primary"
        >
          <Emblem name="retry" size={16} /> Retry {items.length === 1 ? 'it' : 'them'}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * The move on the board, the way Chess.com's review reads it: the grade, the
 * move it should have been, what it cost and why. Everything else in the panel
 * is a summary; this is the part that changes as the player steps. Its box is
 * the same height whatever it says, so stepping moves nothing.
 */
function CurrentMove({
  annotations,
  fenHistory,
  you,
}: {
  annotations: ReplayMoveAnnotation[]
  fenHistory: string[]
  you: 'white' | 'black'
}) {
  const currentFen = useAppStore((state) => state.nodes[state.currentNodeId]?.fen ?? null)
  const annotation = annotationAtFen(annotations, currentFen)
  const asked = useMemo(() => (annotation ? [annotation] : []), [annotation])
  const explanations = useMoveExplanations(asked, fenHistory)
  const explanation = annotation ? explanations.get(annotation.ply) : undefined
  if (!annotation) {
    return (
      <section aria-live="polite" className="review-move" data-label="none">
        <div className="review-move__head">
          <strong>Start of the game</strong>
        </div>
        <p className="review-move__best">Step through the moves. Each one is judged here.</p>
        <p className="review-move__why">&nbsp;</p>
      </section>
    )
  }
  const mover = annotation.fen.split(' ')[1] === 'w' ? 'black' : 'white'
  const parentFen = fenHistory[annotation.ply - 1]
  const bestSan =
    annotation.bestMove && parentFen
      ? uciToSan(parentFen, annotation.bestMove)
      : annotation.bestMove
  const costly = annotation.cpLoss != null && annotation.cpLoss > 40
  const detail =
    annotation.label === 'Brilliant'
      ? "A piece sacrifice that is also the engine's move."
      : annotation.label === 'Best' || annotation.cpLoss === 0
        ? "The engine's own choice."
        : annotation.label === 'Book'
          ? 'Masters play this here.'
          : annotation.label == null
            ? 'Not judged yet.'
            : bestSan
              ? `Best was ${bestSan}.`
              : ''
  return (
    <section aria-live="polite" className="review-move" data-label={annotation.label ?? 'none'}>
      <div className="review-move__head">
        <span className="review-move__icon">
          {annotation.label ? <AnnotationIcon label={annotation.label} size={22} /> : null}
        </span>
        <strong>
          {moveNumber(annotation.ply)} {annotation.san}
        </strong>
        <span className="review-move__verdict">{describeLabel(annotation.label)}</span>
        <span className="review-move__who muted">{mover === you ? 'you' : 'opponent'}</span>
        {costly ? <span className="review-move__cost">{formatCost(annotation.cpLoss)}</span> : null}
      </div>
      <p className="review-move__best">{detail || '\u00a0'}</p>
      <p
        className="review-move__why"
        title={
          explanation ? `${explanation.label}. ${explanation.detail ?? explanation.cue}` : undefined
        }
      >
        {explanation ? (
          <>
            <strong>{explanation.label}.</strong> {explanation.detail ?? explanation.cue}
          </>
        ) : (
          '\u00a0'
        )}
      </p>
    </section>
  )
}

/** Each side's accuracy and the count of every grade, Chess.com's summary table. */
function ReviewSummary({
  annotations,
  fenHistory,
  you,
  opponentTitle,
}: {
  annotations: ReplayMoveAnnotation[]
  fenHistory: string[]
  you: 'white' | 'black'
  opponentTitle: string
}) {
  const analysisVersion = useEngineStore((state) => state.analysisVersion)
  const them = you === 'white' ? 'black' : 'white'
  const { mine, theirs, mineAccuracy, theirAccuracy } = useMemo(() => {
    const analysisByFen = useEngineStore.getState().analysisByFen
    return {
      mine: reviewSide(annotations, you),
      theirs: reviewSide(annotations, them),
      mineAccuracy: sideAccuracy(annotations, fenHistory, analysisByFen, you),
      theirAccuracy: sideAccuracy(annotations, fenHistory, analysisByFen, them),
    }
    // analysisVersion: the evaluations behind the accuracy arrive after the grades.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, fenHistory, you, them, analysisVersion])
  return (
    <div className="review-summary">
      <div className="review-summary__sides">
        <div className="review-summary__side" data-you>
          <span className="review-summary__name">You</span>
          <strong className="review-summary__accuracy">
            {mineAccuracy == null ? '—' : mineAccuracy.toFixed(1)}
          </strong>
          <span className="muted">accuracy</span>
        </div>
        <div className="review-summary__side">
          <span className="review-summary__name">{opponentTitle}</span>
          <strong className="review-summary__accuracy">
            {theirAccuracy == null ? '—' : theirAccuracy.toFixed(1)}
          </strong>
          <span className="muted">accuracy</span>
        </div>
      </div>
      <table className="review-counts">
        <tbody>
          {REVIEW_LABELS.map((label) => (
            <tr key={label}>
              <td className="review-counts__count">{mine.counts[label] || '·'}</td>
              <td className="review-counts__label">
                <AnnotationIcon label={label} size={15} />
                <span title={annotationTitle(label)}>{label}</span>
              </td>
              <td className="review-counts__count">{theirs.counts[label] || '·'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * What the engine made of the line currently on the board: a scoreline per
 * side and the moves that actually cost something, each one a link back to the
 * position it happened in.
 */
export function GameReviewPanel({
  annotations,
  fenHistory,
  opponentTitle = 'Opponent',
  reviewDepth,
  userColor,
}: {
  annotations: ReplayMoveAnnotation[]
  fenHistory: string[]
  opponentTitle?: string
  /** The depth this line is reviewed at; one line is never reviewed at two. */
  reviewDepth?: number
  userColor: 'white' | 'black' | null
}) {
  const coverage = reviewCoverage(annotations)
  const progress = useAnalysisProgress()
  const { analyzeLine, canAnalyze } = useAnalyzeLine()
  useReviewReward(annotations.length, coverage.complete, fenHistory)
  const retrying = useIsRetrying()

  const you = userColor ?? 'white'

  return (
    <Card>
      <CardBody>
        {retrying ? (
          <RetryMistakes />
        ) : !annotations.length ? (
          <EmptyState
            title="Nothing to review"
            message="Pick one of your games in the Library to see every move graded."
          />
        ) : (
          <>
            {progress.active ? (
              <p className="review-progress">
                Analyzing {progress.completed} of {progress.total}
                {progress.etaSeconds != null
                  ? `, about ${formatDuration(progress.etaSeconds)} left`
                  : null}
              </p>
            ) : !coverage.complete ? (
              <div className="review-cta">
                <p>
                  {coverage.judged === 0
                    ? "The engine hasn't looked at this game yet."
                    : `${coverage.total - coverage.judged} of ${coverage.total} moves still to check.`}
                </p>
                <Button
                  disabled={!canAnalyze}
                  onClick={() => void analyzeLine({ depth: reviewDepth })}
                  type="button"
                  variant="primary"
                >
                  {coverage.judged === 0 ? 'Review this game' : 'Finish the review'}
                </Button>
              </div>
            ) : null}

            <EvalGraph annotations={annotations} fenHistory={fenHistory} />

            <CurrentMove annotations={annotations} fenHistory={fenHistory} you={you} />

            <ReviewSummary
              annotations={annotations}
              fenHistory={fenHistory}
              opponentTitle={opponentTitle}
              you={you}
            />

            {coverage.complete ? (
              <RetryButton annotations={annotations} fenHistory={fenHistory} side={you} />
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  )
}
