import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { EvalGraph } from '@/components/analysis/eval-graph'
import { Emblem, Medal } from '@/components/training/trophies'
import { RetryMistakes, useIsRetrying, useRetryStore } from '@/components/analysis/retry-mistakes'
import { AnnotationIcon, annotationTitle } from '@/components/ui/annotation-icon'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCost, REVIEW_LABELS, reviewCoverage, reviewSide } from '@/lib/analysis/game-review'
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

function Scoreline({
  annotations,
  fenHistory,
  side,
  title,
}: {
  annotations: ReplayMoveAnnotation[]
  fenHistory: string[]
  side: 'white' | 'black'
  title: string
}) {
  const review = useMemo(() => reviewSide(annotations, side), [annotations, side])
  // Jumping lands on the game's own node, keeping the move list, the
  // highlight and the annotations; pushing a branch here lost all three.
  const jumpToFen = useAppStore((state) => state.jumpToFen)
  // SAN needs a board per move; worked out once per review, not per render.
  const bestSan = useMemo(
    () =>
      new Map(
        review.costly.map((move) => [
          move.ply,
          move.bestMove && fenHistory[move.ply - 1]
            ? uciToSan(fenHistory[move.ply - 1], move.bestMove)
            : move.bestMove,
        ]),
      ),
    [fenHistory, review.costly],
  )
  const shown = review.costly.slice(0, 6)
  const explanations = useMoveExplanations(shown, fenHistory)

  return (
    <div className="scoreline">
      <div className="scoreline__head">
        <strong>{title}</strong>
        <span className="scoreline__acpl">
          {review.averageLossCp == null ? '—' : `${review.averageLossCp} avg loss`}
        </span>
      </div>

      <div className="scoreline__chips">
        {REVIEW_LABELS.filter((label) => review.counts[label] > 0).map((label) => (
          <span className="scoreline__chip" key={label} title={annotationTitle(label)}>
            <AnnotationIcon label={label} size={15} />
            {review.counts[label]}
          </span>
        ))}
        {review.judged === 0 ? <span className="muted">Not judged yet</span> : null}
      </div>

      {review.costly.length ? (
        <ul className="scoreline__costly">
          {shown.map((move) => (
            <li key={move.ply}>
              <button onClick={() => jumpToFen(move.fen)} type="button">
                <AnnotationIcon label={move.label!} size={14} />
                <span className="scoreline__move">
                  {moveNumber(move.ply)} {move.san}
                </span>
                <span className="scoreline__cost">{formatCost(move.cpLoss)}</span>
                {move.bestMove ? (
                  <span className="scoreline__better">best {bestSan.get(move.ply)}</span>
                ) : null}
              </button>
              <MoveWhy explanation={explanations.get(move.ply)} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** One line on why a move cost what it did; the box is there before the words arrive. */
function MoveWhy({ explanation }: { explanation: MoveExplanation | undefined }) {
  const text = explanation ? (explanation.detail ?? explanation.cue) : ''
  return (
    <p className="scoreline__why" title={explanation ? `${explanation.label}. ${text}` : undefined}>
      {explanation ? (
        <>
          <strong>{explanation.label}.</strong> {text}
        </>
      ) : null}
    </p>
  )
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
  const them = you === 'white' ? 'black' : 'white'

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

            {coverage.complete ? (
              <RetryButton annotations={annotations} fenHistory={fenHistory} side={you} />
            ) : null}

            <Scoreline annotations={annotations} fenHistory={fenHistory} side={you} title="You" />
            <Scoreline
              annotations={annotations}
              fenHistory={fenHistory}
              side={them}
              title={opponentTitle}
            />
          </>
        )}
      </CardBody>
    </Card>
  )
}
