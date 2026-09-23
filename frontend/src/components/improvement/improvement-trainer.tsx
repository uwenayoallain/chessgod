import {
  Brain,
  Check,
  ChevronRight,
  ExternalLink,
  RotateCcw,
  Swords,
  Target,
  Timer,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { getTrainingTimeClass, useImprovementPlan, type DrillCard } from '@/hooks/use-improvement'
import { DrillContinuation } from '@/components/improvement/drill-continuation'
import { drillLine, drillStep, drillStepLabel } from '@/lib/drills/drill-steps'
import {
  describeAccuracy,
  describeCoverage,
  describeSessionEstimate,
} from '@/lib/drills/session-summary'
import { getLessonAvailability, readyCountInView } from '@/lib/lesson-availability'
import { useAppStore } from '@/store/app-store'

const RECURRENCE_LABEL = {
  habit: 'repeated habit',
  repeated: 'same position again',
  one_off: 'one-off',
} as const

const TRAINING_GLYPHS: Record<string, string> = {
  advantage_conversion: '♛',
  fork: '♞',
  skewer: '♜',
  opening_decision: '♙',
  hanging_material: '♟',
  pin: '♝',
  missed_capture: '×',
  king_safety: '♚',
  calculation: '∞',
  allowed_mate: '!',
  missed_mate: '#',
  removing_the_defender: '◇',
  defensive_resource: '↶',
}

type DrillStatus =
  | 'idle'
  | 'solving'
  | 'follow-up'
  | 'correct'
  | 'incorrect'
  | 'revealed'
  | 'save-error'

type ImprovementTrainerProps = {
  username: string
  color: 'white' | 'black' | 'both'
  timeClass: string | null
  onBeginDrill?: () => void
  /** Play the drill position out against the engine, from the Explore tab. */
  onPlayOut?: (position: { fen: string; lastUci: string | null }) => void
}

export function ImprovementTrainer(props: ImprovementTrainerProps) {
  // Remount only when the learning scope changes, resetting the selected theme,
  // active question and pending-response ownership together.
  const scopeKey = JSON.stringify([
    props.username,
    props.color,
    getTrainingTimeClass(props.timeClass),
  ])
  return <ScopedImprovementTrainer key={scopeKey} {...props} />
}

function ScopedImprovementTrainer({
  username,
  color,
  timeClass,
  onBeginDrill,
  onPlayOut,
}: ImprovementTrainerProps) {
  const [selectedPattern, setSelectedPattern] = useState<string | null>(null)
  const plan = useImprovementPlan({ username, color, timeClass, patternKey: selectedPattern })
  const loadPosition = useAppStore((state) => state.loadPosition)
  const clearLoadedLine = useAppStore((state) => state.clearLoadedLine)
  const alignBoardToUserColor = useAppStore((state) => state.alignBoardToUserColor)
  const setDrillSolving = useAppStore((state) => state.setDrillSolving)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const nodes = useAppStore((state) => state.nodes)
  const [sessionActive, setSessionActive] = useState(false)
  const [sessionDrills, setSessionDrills] = useState<DrillCard[]>([])
  const [index, setIndex] = useState(0)
  const [status, setStatus] = useState<DrillStatus>('idle')
  const [playedMove, setPlayedMove] = useState<string | null>(null)
  const [firstMove, setFirstMove] = useState<string | null>(null)
  // Which ply of the drill the reader was on when they asked for the answer.
  // 'revealed' on its own cannot say, so the reveal always described move one.
  const [askedStep, setAskedStep] = useState(1)
  const [intent, setIntent] = useState<string | null>(null)
  const [intentFeedback, setIntentFeedback] = useState<string | null>(null)
  const startedAt = useRef(0)
  const submittedNodeId = useRef<string | null>(null)
  const activeAttemptId = useRef<string | null>(null)

  const availableDrills = (plan.data?.drills ?? []).filter(
    (drill) => selectedPattern === null || drill.pattern_key === selectedPattern,
  )
  // A query refresh must not change the question while its board is open.
  const drills = sessionActive ? sessionDrills : availableDrills
  const card = drills[index] ?? null
  const step = card ? drillStep(card, status === 'follow-up' ? 'follow-up' : 'solving') : null
  const stepLabel = step ? drillStepLabel(step) : null
  // What to name as the best move once revealed: the move for the step actually
  // being asked, which for a two-move drill is not the one already played.
  const revealedAnswerSan =
    card && askedStep === 2 && card.follow_up ? card.follow_up.best_move_san : card?.best_move_san
  const currentNode = nodes[currentNodeId]

  function loadCard(nextCard: DrillCard, nextIndex = index) {
    activeAttemptId.current = null
    setIndex(nextIndex)
    setPlayedMove(null)
    setFirstMove(null)
    setAskedStep(1)
    setIntent(null)
    setIntentFeedback(null)
    setStatus('solving')
    submittedNodeId.current = null
    startedAt.current = performance.now()
    // Highlight the move being answered, as the follow-up step already does.
    loadPosition(nextCard.fen, nextCard.previous_move_uci ?? null)
    alignBoardToUserColor(nextCard.side_to_move)
  }

  function startSession() {
    const firstCard = availableDrills[0]
    if (!firstCard) return
    onBeginDrill?.()
    setSessionDrills([...availableDrills])
    setSessionActive(true)
    loadCard(firstCard, 0)
  }

  function stopSession() {
    activeAttemptId.current = null
    setSessionActive(false)
    setStatus('idle')
    clearLoadedLine()
  }

  function nextCard() {
    if (!drills.length) return
    if (index >= drills.length - 1) {
      stopSession()
      void plan.refetch()
      return
    }
    const nextIndex = index + 1
    loadCard(drills[nextIndex], nextIndex)
  }

  // Keep the board honest: no engine arrows or annotations while a card is open.
  useEffect(() => {
    setDrillSolving(sessionActive && (status === 'solving' || status === 'follow-up'))
  }, [sessionActive, setDrillSolving, status])

  useEffect(
    () => () => {
      activeAttemptId.current = null
      setDrillSolving(false)
    },
    [setDrillSolving],
  )

  useEffect(() => {
    if (!sessionActive || !card) return
    if (status !== 'solving' && status !== 'follow-up') return
    // One submitted answer per loaded card. Further board exploration while
    // saving must not become extra graded attempts.
    if (activeAttemptId.current !== null) return
    if (!currentNode?.parentId || !currentNode.uci) return
    if (submittedNodeId.current === currentNode.id) return
    submittedNodeId.current = currentNode.id
    const move = currentNode.uci
    setPlayedMove(currentNode.san ?? move)

    // A calculation drill only asks for the second move once the first one matches
    // the stored line; anything else is submitted straight away and scored server-side.
    if (status === 'solving' && card.follow_up && move === card.best_move_uci) {
      setAskedStep(2)
      setFirstMove(move)
      setStatus('follow-up')
      submittedNodeId.current = null
      // Show the reply being answered: the drill jumps to a new position, so
      // without this the board gives no sign of what the opponent just played.
      loadPosition(card.follow_up.fen, card.follow_up.opponent_reply_uci)
      alignBoardToUserColor(card.side_to_move)
      return
    }

    const responseMs = Math.max(0, Math.round(performance.now() - startedAt.current))
    const requestId = crypto.randomUUID()
    activeAttemptId.current = requestId
    plan.attempt.mutate(
      {
        username,
        request_id: requestId,
        position_id: card.position_id,
        expected_move_uci: card.best_move_uci,
        played_move_uci: status === 'follow-up' ? (firstMove ?? card.best_move_uci) : move,
        follow_up_move_uci: status === 'follow-up' ? move : null,
        expected_follow_up: card.follow_up ?? null,
        pattern_key: card.pattern_key,
        intent_key: intent,
        response_ms: responseMs,
      },
      {
        onError: () => {
          if (activeAttemptId.current !== requestId) return
          setStatus('save-error')
        },
        onSuccess: (result) => {
          if (activeAttemptId.current !== requestId) return
          setIntentFeedback(result.intent_feedback)
          setStatus(result.correct ? 'correct' : 'incorrect')
        },
      },
    )
  }, [
    alignBoardToUserColor,
    card,
    currentNode,
    firstMove,
    intent,
    loadPosition,
    plan.attempt,
    sessionActive,
    status,
    username,
  ])

  if (plan.isLoading && !plan.data) {
    // Sized like the loaded trainer (scope, summary, then a row per theme) so
    // the sections below it do not get pushed down when the plan arrives.
    return (
      <Card className="improvement-trainer">
        <CardBody className="column" style={{ gap: 12 }}>
          <PanelSkeleton label="Loading your lessons" rowHeight={64} rows={2} />
          <PanelSkeleton label="Loading your lessons" rowHeight={56} rows={6} />
        </CardBody>
      </Card>
    )
  }

  if (!plan.data) {
    return (
      <div className="improvement-empty improvement-empty--error">
        The training queue did not load. Check that the backend is running, then try again.
      </div>
    )
  }

  const summary = plan.data.summary
  const patterns = summary.patterns
  const selectedSummary = patterns.find((pattern) => pattern.key === selectedPattern) ?? null
  // The plan is fetched per theme, so `drills` is theme-scoped while
  // `due_positions` counts everything. Badge and body must agree.
  const availabilityInput = {
    selectedPattern,
    selectedDue: selectedSummary?.due_positions ?? null,
    totalDue: summary.due_positions,
  }
  const readyInView = readyCountInView(availabilityInput)
  const availability = getLessonAvailability({ ...availabilityInput, drillCount: drills.length })
  const learnedPositions = patterns.reduce((total, pattern) => total + pattern.learned_positions, 0)
  const isLastCard = index === drills.length - 1
  const sessionMinutes = Math.max(1, Math.round(summary.session_seconds / 60))
  // Why the set stops at ten or so however many positions the theme has: the
  // server fills a fixed time budget, not a fixed count.
  const sessionEstimate = describeSessionEstimate({
    availablePositions: selectedSummary?.positions ?? drills.length,
    drillCount: drills.length,
    sessionSeconds: summary.session_seconds,
  })

  return (
    <Card className="improvement-trainer">
      <CardHeader className="improvement-trainer__header">
        <div>
          <h2>{sessionActive ? (card?.pattern_label ?? 'Training') : 'Pick a lesson'}</h2>
        </div>
        {sessionActive ? (
          <Button
            aria-label="End drill session"
            onClick={stopSession}
            type="button"
            variant="ghost"
          >
            <X size={15} />
          </Button>
        ) : (
          <span className="improvement-trainer__due">{readyInView.toLocaleString()} ready</span>
        )}
      </CardHeader>
      <CardBody className="improvement-trainer__body">
        {availability.kind === 'theme-clear' ? (
          <div className="improvement-empty">
            <Target size={20} />
            <strong>{selectedSummary?.label ?? 'This theme'} is clear</strong>
            <span>
              You have drilled every position in it. {availability.elsewhere}{' '}
              {availability.elsewhere === 1 ? 'lesson is' : 'lessons are'} ready in other themes,
              and these come back later for review.
            </span>
            <Button onClick={() => setSelectedPattern(null)} type="button" variant="primary">
              Show all lessons
            </Button>
          </div>
        ) : availability.kind === 'none' ? (
          <div className="improvement-empty">
            <Target size={20} />
            <strong>No lessons yet</strong>
            <span>
              Open Analysis Coverage below and set the engine on your games — or analyze a single
              line from Explore. Every mistake it finds in your Rapid and Blitz games at rating{' '}
              {plan.data.min_user_rating}+ turns up here as a lesson.
            </span>
          </div>
        ) : sessionActive && card ? (
          <div className="drill-card">
            <div
              className="drill-card__clock"
              aria-label={`Position ${index + 1} of ${drills.length}`}
            >
              <Timer size={16} />
              <span>{String(index + 1).padStart(2, '0')}</span>
              <span className="drill-card__clock-divider">/</span>
              <span>{String(drills.length).padStart(2, '0')}</span>
            </div>
            <div className="drill-card__meta">
              <strong>{card.pattern_label}</strong>
              <span className="drill-card__phase">{card.phase}</span>
              <span className={`recurrence recurrence--${card.recurrence}`}>
                {RECURRENCE_LABEL[card.recurrence]}
              </span>
              {stepLabel ? <span className="drill-card__step">{stepLabel}</span> : null}
            </div>
            <div className="drill-card__prompt">
              {status === 'follow-up' && card.follow_up ? (
                <>
                  <strong>
                    Right so far. The opponent answers {card.follow_up.opponent_reply_san}.
                  </strong>
                  <span>Play the move you had calculated next.</span>
                </>
              ) : (
                <>
                  <strong>{card.side_to_move === 'white' ? 'White' : 'Black'} to move.</strong>
                  <span>
                    {card.follow_up
                      ? 'Play the move you would choose, then the follow-up it depends on.'
                      : 'Play the move you would choose in a game.'}
                  </span>
                </>
              )}
            </div>

            {status === 'solving' ? (
              <fieldset className="drill-intents">
                <legend>What are you checking? (optional)</legend>
                {plan.data.intents.map((option) => (
                  <button
                    aria-pressed={intent === option.key}
                    className={`drill-intents__option${
                      intent === option.key ? ' drill-intents__option--on' : ''
                    }`}
                    key={option.key}
                    onClick={() => setIntent(intent === option.key ? null : option.key)}
                    title={option.prompt}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </fieldset>
            ) : null}

            {status === 'solving' || status === 'follow-up' ? (
              <div className="drill-card__actions">
                <Button
                  onClick={() => {
                    // Capture the step being given up on; 'revealed' alone cannot
                    // say whether the reader was stuck on the move or the follow-up.
                    setAskedStep(status === 'follow-up' && card.follow_up ? 2 : 1)
                    setStatus('revealed')
                  }}
                  type="button"
                >
                  Show hint &amp; solution
                </Button>
              </div>
            ) : null}

            {status !== 'solving' && status !== 'follow-up' ? (
              <div
                className={`drill-feedback drill-feedback--${status === 'correct' ? 'correct' : 'review'}`}
                role="status"
              >
                <div className="drill-feedback__title">
                  {status === 'correct' ? <Check size={18} /> : <Brain size={18} />}
                  <strong>
                    {status === 'correct'
                      ? 'Found it.'
                      : status === 'save-error'
                        ? 'That move could not be saved.'
                        : status === 'incorrect'
                          ? `${playedMove ?? 'That move'} misses the point.`
                          : `Best move: ${revealedAnswerSan}`}
                  </strong>
                </div>
                {status === 'save-error' ? (
                  <p>Check the connection, then reset this position and play the move again.</p>
                ) : (
                  <>
                    <div className="drill-card__actions drill-card__actions--primary">
                      {status !== 'correct' ? (
                        <Button onClick={() => loadCard(card)} type="button">
                          <RotateCcw size={14} /> Try again
                        </Button>
                      ) : null}
                      <Button onClick={nextCard} type="button" variant="primary">
                        {isLastCard ? 'Finish session' : 'Next position'}
                      </Button>
                      {onPlayOut ? (
                        <Button
                          onClick={() =>
                            onPlayOut(
                              askedStep === 2 && card.follow_up
                                ? {
                                    fen: card.follow_up.fen,
                                    lastUci: card.follow_up.opponent_reply_uci,
                                  }
                                : { fen: card.fen, lastUci: card.previous_move_uci ?? null },
                            )
                          }
                          type="button"
                        >
                          <Swords size={14} /> Play it out
                        </Button>
                      ) : null}
                    </div>
                    <div className="drill-feedback__lesson">
                      <p>{card.explanation}</p>
                      {card.follow_up ? (
                        <p className="drill-feedback__line">
                          The line runs{' '}
                          {drillLine(card, askedStep).map((ply, i) => (
                            <span
                              className={`drill-line__ply drill-line__ply--${ply.side}${
                                ply.isAnswer ? ' drill-line__ply--asked' : ''
                              }`}
                              key={`${ply.san}-${i}`}
                              title={ply.isAnswer ? 'The move you were asked for' : undefined}
                            >
                              {ply.san}
                            </span>
                          ))}
                        </p>
                      ) : null}
                      {intentFeedback ? (
                        <p className="drill-feedback__intent">{intentFeedback}</p>
                      ) : null}
                      {/* The card says which move and why; the engine says what
                          happens next, which is the question the position
                          actually leaves open. Rooted at the ply the drill was
                          asking about. */}
                      <DrillContinuation
                        active={
                          status === 'correct' || status === 'incorrect' || status === 'revealed'
                        }
                        fen={askedStep === 2 && card.follow_up ? card.follow_up.fen : card.fen}
                      />
                      <p className="drill-feedback__cue">Remember: {card.cue}</p>
                      {card.motifs.length > 0 ? (
                        <details className="drill-feedback__details">
                          <summary>See tactical details</summary>
                          <ul className="drill-feedback__motifs">
                            {card.motifs.map((motif) => (
                              <li key={`${motif.side}-${motif.key}`}>
                                <span className={`drill-motif drill-motif--${motif.side}`}>
                                  {motif.side === 'allowed' ? 'Allowed' : 'Available'}
                                </span>
                                <span className="drill-motif__label">{motif.label}</span>
                                <span className="drill-motif__detail">{motif.detail}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </div>
                  </>
                )}
                <div className="drill-card__source">
                  <a
                    className="button button--ghost"
                    href={card.source_game_url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Game <ExternalLink size={13} />
                  </a>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <p className="training-scope">
              Lessons come from your Rapid and Blitz games at rating {plan.data.min_user_rating}+.
            </p>
            <div className="improvement-summary" aria-label="Training progress">
              <div>
                <strong>
                  {summary.candidate_positions.toLocaleString()}
                  {summary.candidate_positions_is_lower_bound ? '+' : ''}
                </strong>
                <span>lessons found</span>
              </div>
              <div>
                <strong>{learnedPositions.toLocaleString()}</strong>
                <span>learned</span>
              </div>
              <div>
                <strong>{summary.due_positions.toLocaleString()}</strong>
                <span>ready now</span>
              </div>
            </div>
            <div className="training-library">
              <div className="training-library__heading">
                <strong>Your weaknesses</strong>
                <span>{patterns.length} themes</span>
              </div>
              {selectedSummary ? (
                <div className="training-selection" role="status">
                  <div>
                    <span>Selected lesson</span>
                    <strong>{selectedSummary.label}</strong>
                    <small>
                      {describeCoverage(selectedSummary)} · {describeAccuracy(selectedSummary)}
                    </small>
                  </div>
                  {/* One slot, always present. The three states here are different
                      shapes, so swapping them resized the row and moved the list
                      below it every time the plan refetched. */}
                  <div className="training-selection__action">
                    {plan.isFetching ? (
                      <span className="training-selection__wait">Preparing…</span>
                    ) : drills.length ? (
                      <Button
                        onClick={startSession}
                        title={sessionEstimate}
                        type="button"
                        variant="primary"
                      >
                        <Target size={16} /> Train {drills.length}{' '}
                        {drills.length === 1 ? 'position' : 'positions'} · ~{sessionMinutes} min
                      </Button>
                    ) : (
                      <strong className="training-selection__caught-up">Caught up</strong>
                    )}
                  </div>
                </div>
              ) : (
                <p className="training-library__instruction">
                  Pick one to drill. Mastered positions come back later for review.
                </p>
              )}
              <div className="training-library__list">
                {patterns.map((pattern, patternIndex) => {
                  const progress = pattern.positions
                    ? Math.round((pattern.learned_positions / pattern.positions) * 100)
                    : 0
                  const state =
                    pattern.learned_positions === pattern.positions
                      ? 'Learned'
                      : pattern.drill_attempts > 0
                        ? 'In progress'
                        : 'Not started'
                  return (
                    <button
                      aria-label={`Choose ${pattern.label}`}
                      aria-pressed={selectedPattern === pattern.key}
                      className={`training-topic${
                        selectedPattern === pattern.key ? ' training-topic--selected' : ''
                      }`}
                      key={pattern.key}
                      onClick={() => setSelectedPattern(pattern.key)}
                      type="button"
                    >
                      <span className="training-topic__glyph" aria-hidden="true">
                        {TRAINING_GLYPHS[pattern.key] ?? '•'}
                      </span>
                      <span className="training-topic__main">
                        <span className="training-topic__title">
                          <strong>{pattern.label}</strong>
                          {patternIndex === 0 ? <em>Recommended</em> : null}
                        </span>
                        <span className="training-topic__meta">
                          {state} · {pattern.learned_positions.toLocaleString()}/
                          {pattern.positions.toLocaleString()} learned ·{' '}
                          {pattern.due_positions.toLocaleString()} ready
                        </span>
                        <span className="training-topic__track" aria-hidden="true">
                          <i style={{ width: `${progress}%` }} />
                        </span>
                      </span>
                      <ChevronRight size={18} />
                    </button>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  )
}
