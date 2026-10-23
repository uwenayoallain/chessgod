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
import { Emblem, Medal, TitlePiece } from '@/components/training/trophies'
import type { EmblemName } from '@/lib/training/emblem-art'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { getTrainingTimeClass, useImprovementPlan, type DrillCard } from '@/hooks/use-improvement'
import { DrillContinuation } from '@/components/improvement/drill-continuation'
import { HintControl } from '@/components/training/hint-control'
import { useHint } from '@/hooks/use-hint'
import { drillLine, drillStep, drillStepLabel } from '@/lib/drills/drill-steps'
import { recommendedTheme } from '@/lib/drills/recommended'
import {
  describeAccuracy,
  describeCoverage,
  describeSessionEstimate,
} from '@/lib/drills/session-summary'
import { getLessonAvailability, readyCountInView } from '@/lib/lesson-availability'
import { useAppStore } from '@/store/app-store'

const TRAINED_TODAY_KEY = 'chessgod.drills.trainedToday'

function todayKey() {
  return new Date().toISOString().slice(0, 10)
}

function readTrainedToday(): string | null {
  try {
    const raw = window.localStorage.getItem(TRAINED_TODAY_KEY)
    if (!raw) return null
    const [day, key] = raw.split(':', 2)
    return day === todayKey() && key ? key : null
  } catch {
    return null
  }
}

function writeTrainedToday(key: string) {
  try {
    window.localStorage.setItem(TRAINED_TODAY_KEY, `${todayKey()}:${key}`)
  } catch {
    // A per-viewer convenience; the themes still list without it.
  }
}

const RECURRENCE_LABEL = {
  habit: 'habit',
  repeated: 'same position again',
  one_off: 'one-off',
} as const

// Each theme's emblem from the set: the piece that does it where one does.
const TRAINING_EMBLEMS: Record<string, EmblemName> = {
  advantage_conversion: 'queen',
  fork: 'knight',
  skewer: 'rook',
  opening_decision: 'book',
  hanging_material: 'pawn',
  pin: 'bishop',
  missed_capture: 'crosshair',
  king_safety: 'king',
  calculation: 'magnifier',
  allowed_mate: 'king',
  missed_mate: 'crown',
  removing_the_defender: 'swords',
  defensive_resource: 'shield',
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
  // The theme trained most recently today: recommended moves past it.
  const [trainedToday, setTrainedToday] = useState<string | null>(() => readTrainedToday())
  const plan = useImprovementPlan({ username, color, timeClass, patternKey: selectedPattern })
  const loadPosition = useAppStore((state) => state.loadPosition)
  const clearLoadedLine = useAppStore((state) => state.clearLoadedLine)
  const alignBoardToUserColor = useAppStore((state) => state.alignBoardToUserColor)
  const setDrillSolving = useAppStore((state) => state.setDrillSolving)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const nodes = useAppStore((state) => state.nodes)
  const [sessionActive, setSessionActive] = useState(false)
  // Each card's outcome as it resolves, and the finish screen once the set ends.
  const outcomes = useRef<Map<number, boolean>>(new Map())
  const [finished, setFinished] = useState<{ results: boolean[]; theme: string | null } | null>(
    null,
  )
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
  // Rooted at the ply being asked: the follow-up position for a second step.
  const askedFen = status === 'follow-up' && card?.follow_up ? card.follow_up.fen : card?.fen
  const hints = useHint(
    (status === 'solving' || status === 'follow-up') && card && step && askedFen
      ? { fen: askedFen, uci: step.answerUci }
      : null,
    card && step ? `${card.position_id}:${step.index}` : null,
  )
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
    outcomes.current = new Map()
    setFinished(null)
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
      // The set is over: show what it came to before going back to the themes.
      setFinished({
        results: drills.map((_, at) => outcomes.current.get(at) ?? false),
        theme: drills[0]?.pattern_key ?? null,
      })
      if (drills[0]?.pattern_key) {
        writeTrainedToday(drills[0].pattern_key)
        setTrainedToday(drills[0].pattern_key)
      }
      stopSession()
      void plan.refetch()
      return
    }
    const nextIndex = index + 1
    loadCard(drills[nextIndex], nextIndex)
  }

  // A card's first resolution is its outcome; a retry after a miss does not rewrite it.
  useEffect(() => {
    if (!sessionActive) return
    if (status !== 'correct' && status !== 'incorrect' && status !== 'revealed') return
    if (!outcomes.current.has(index)) outcomes.current.set(index, status === 'correct')
  }, [index, sessionActive, status])

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
        Your lessons didn't load. Try again in a moment.
      </div>
    )
  }

  const summary = plan.data.summary
  const patterns = summary.patterns
  // What to drill next: the first theme with positions ready that was not the
  // one just trained today, so a finished set never comes back as the
  // recommendation the moment it ends.
  const recommendedKey = recommendedTheme(patterns, trainedToday)
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
          <h2>{sessionActive ? (card?.pattern_label ?? 'Training') : 'Drills'}</h2>
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
        {finished && !sessionActive ? (
          <div className="drill-finish">
            <div className="result-hero">
              <Medal
                earned={finished.results.every(Boolean)}
                emblem={TRAINING_EMBLEMS[finished.theme ?? ''] ?? 'crosshair'}
                label={`${finished.results.filter(Boolean).length} of ${finished.results.length} solved`}
                progress={
                  finished.results.length
                    ? finished.results.filter(Boolean).length / finished.results.length
                    : 0
                }
                size={72}
              />
              <div className="result-hero__text">
                <span className="result-hero__score">
                  {finished.results.filter(Boolean).length}
                  <span className="muted"> / {finished.results.length}</span>
                </span>
                <span className="muted">
                  {finished.results.every(Boolean)
                    ? 'Every position solved on the first try.'
                    : 'Solved on the first try. Misses come back sooner.'}
                </span>
              </div>
            </div>
            <ol aria-label="Positions" className="result-rank">
              {finished.results.map((solved, at) => (
                <li
                  data-found={solved || undefined}
                  data-shade={at % 2 ? 'dark' : 'light'}
                  key={at}
                >
                  {solved ? <TitlePiece title="Pawn" /> : null}
                  <span className="sr-only-inline">
                    Position {at + 1}: {solved ? 'solved' : 'missed'}
                  </span>
                </li>
              ))}
            </ol>
            <Button onClick={() => setFinished(null)} type="button" variant="primary">
              Back to the lessons
            </Button>
          </div>
        ) : availability.kind === 'theme-clear' ? (
          <div className="improvement-empty">
            <Target size={20} />
            <strong>{selectedSummary?.label ?? 'This theme'} is clear</strong>
            <span>
              You've drilled every position in it. {availability.elsewhere}{' '}
              {availability.elsewhere === 1 ? 'lesson is' : 'lessons are'} ready in other themes.
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
              Analyze your games in Analysis coverage below, or review one in Explore. Each mistake
              becomes a lesson.
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
            {/* The theme is already the panel heading while a session runs. */}
            <div className="drill-card__meta">
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
                  <span>Play the follow-up you calculated.</span>
                </>
              ) : (
                <>
                  <strong>{card.side_to_move === 'white' ? 'White' : 'Black'} to move.</strong>
                  {card.follow_up ? <span>Two moves: yours, then the follow-up.</span> : null}
                </>
              )}
            </div>

            {status === 'solving' ? (
              // Folded away: six chips were most of the card, and the hint and
              // the board are what the player is here for.
              <details className="drill-intents__fold">
                <summary>What did you check?</summary>
                <fieldset className="drill-intents">
                  <legend className="sr-only-inline">What did you check before moving?</legend>
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
              </details>
            ) : null}

            {status === 'solving' || status === 'follow-up' ? (
              <HintControl hints={hints} lineFirst>
                <Button
                  onClick={() => {
                    // Capture the step being given up on; 'revealed' alone cannot
                    // say whether the reader was stuck on the move or the follow-up.
                    setAskedStep(status === 'follow-up' && card.follow_up ? 2 : 1)
                    setStatus('revealed')
                  }}
                  type="button"
                >
                  Show solution
                </Button>
              </HintControl>
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
                        ? "Couldn't save that move."
                        : status === 'incorrect'
                          ? `${playedMove ?? 'That move'} isn't it.`
                          : `Best move: ${revealedAnswerSan}`}
                  </strong>
                </div>
                {status === 'save-error' ? (
                  <p>Check your connection, then reset the position and play the move again.</p>
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
              From your rapid and blitz games rated {plan.data.min_user_rating}+.
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
                <strong>Themes</strong>
                <span>{patterns.length}</span>
              </div>
              {selectedSummary ? (
                <div className="training-selection" role="status">
                  <div>
                    <span>Selected theme</span>
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
                <p className="training-library__instruction">Pick a theme to drill.</p>
              )}
              <div className="training-library__list">
                {patterns.map((pattern) => {
                  const progress = pattern.positions
                    ? Math.round((pattern.learned_positions / pattern.positions) * 100)
                    : 0
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
                        <Emblem name={TRAINING_EMBLEMS[pattern.key] ?? 'pawn'} size={30} />
                      </span>
                      <span className="training-topic__main">
                        <span className="training-topic__title">
                          <strong>{pattern.label}</strong>
                          {pattern.key === recommendedKey ? <em>Recommended</em> : null}
                        </span>
                        {/* The bar below carries the state; naming it too said
                            the same thing twice. */}
                        <span className="training-topic__meta">
                          {pattern.learned_positions.toLocaleString()}/
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
