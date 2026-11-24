import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Chess } from 'chess.js'
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  MessageSquareText,
  RotateCcw,
  Swords,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ExploreButton } from '@/components/ui/explore-button'
import { HintControl } from '@/components/training/hint-control'
import { SpeakButton } from '@/components/training/speak-button'
import { Medal, TitlePiece } from '@/components/training/trophies'
import { useHint } from '@/hooks/use-hint'
import { invalidateStudyCourses, submitStudyCourseReview } from '@/hooks/use-study-guide'
import { useApplyReward } from '@/hooks/use-training'
import { PLAY_ARROW_COLOR, type BoardArrow } from '@/lib/analysis/board-guidance'
import { play } from '@/lib/sound'
import { prefetchSpeech, readAutoRead, speak, stopSpeech, writeAutoRead } from '@/lib/speech'
import { browserTimeZone, readDailyGoal } from '@/lib/training/progress'
import type {
  StudyCourseColor,
  StudyCourseLine,
  StudyCourseMove,
  StudyCourseReviewResponse,
  StudyMarkColor,
  StudyTrainMode,
} from '@/lib/training/study-types'
import { useAppStore, type BoardHighlight } from '@/store/app-store'

const OPPONENT_DELAY_MS = 400
const ROLLBACK_DELAY_MS = 600

/** The colours a study author draws with, as the board's arrows and marked squares draw them. */
export const STUDY_ARROW_COLORS: Record<StudyMarkColor, string> = {
  green: 'rgba(21, 120, 27, 0.8)',
  red: 'rgba(214, 60, 45, 0.85)',
  blue: 'rgba(0, 72, 160, 0.8)',
  yellow: 'rgba(230, 170, 0, 0.85)',
}

type Phase = 'playing' | 'waiting' | 'finished'

type Feedback = { kind: 'right' | 'wrong'; text: string }

export type StudyNextStep = { label: string; onSelect: () => void }

function fullFen(fen: string) {
  return fen.split(' ').length >= 6 ? fen : `${fen} 0 1`
}

function sameBoard(a: string, b: string) {
  return a.split(' ').slice(0, 4).join(' ') === b.split(' ').slice(0, 4).join(' ')
}

function authorArrows(move: StudyCourseMove | undefined): BoardArrow[] {
  if (!move) return []
  return move.arrows.map((arrow) => ({
    startSquare: arrow.from,
    endSquare: arrow.to,
    color: STUDY_ARROW_COLORS[arrow.color] ?? STUDY_ARROW_COLORS.green,
  }))
}

/** The author's `[%csl]` squares for a move, as the board marks them. */
function authorHighlights(move: StudyCourseMove | undefined): BoardHighlight[] {
  if (!move) return []
  return move.highlights.map((mark) => ({
    square: mark.square,
    color: STUDY_ARROW_COLORS[mark.color] ?? STUDY_ARROW_COLORS.green,
  }))
}

function moveArrow(move: StudyCourseMove): BoardArrow {
  return {
    startSquare: move.uci.slice(0, 2),
    endSquare: move.uci.slice(2, 4),
    color: PLAY_ARROW_COLOR,
  }
}

/** "5." for White, "5..." for Black, counted from the line's own start. */
export function moveLabels(line: StudyCourseLine): string[] {
  const fields = fullFen(line.start_fen).split(' ')
  let number = Number.parseInt(fields[5] ?? '1', 10) || 1
  return line.moves.map((move) => {
    const black = move.fen.split(' ')[1] === 'b'
    const label = `${number}${black ? '...' : '.'}`
    if (black) number += 1
    return label
  })
}

/** The position after the move at `at`, or the line's start when there is no such move. */
export function positionAfter(
  line: StudyCourseLine,
  at: number,
): { fen: string; lastUci: string | null } {
  const move = line.moves[at]
  if (!move) return { fen: fullFen(line.start_fen), lastUci: null }
  try {
    const board = new Chess(fullFen(move.fen))
    board.move({
      from: move.uci.slice(0, 2),
      to: move.uci.slice(2, 4),
      promotion: move.uci.slice(4) || undefined,
    })
    return { fen: board.fen(), lastUci: move.uci }
  } catch {
    return { fen: fullFen(move.fen), lastUci: null }
  }
}

/** The position after the last move of the line, or its start when it has none. */
export function finalPosition(line: StudyCourseLine): { fen: string; lastUci: string | null } {
  return positionAfter(line, line.moves.length - 1)
}

/**
 * One line of an imported study, played on the real board.
 *
 * The opponent's moves play themselves, with the author's comment beside them.
 * In Learn mode each of the player's moves comes with its comment, the
 * author's arrows and a green arrow for the move itself. In Practice mode
 * nothing is shown until the player has tried or asked for a hint. A wrong
 * move is taken back, the right one and its comment are shown, and the player
 * plays it by hand before the line goes on. Only the first try at each move is
 * sent, and the server scores it against the line. Once the line is over, any
 * move of it can be stepped back to, with its comment and marks on the board.
 */
export function StudyCourseTrainer({
  username,
  courseId,
  courseTitle,
  color,
  line,
  mode,
  next,
  onPracticeAgain,
  onPlayOut,
  onClose,
  backLabel = 'Back to course',
}: {
  username: string
  courseId: number
  courseTitle: string
  color: StudyCourseColor
  line: StudyCourseLine
  mode: StudyTrainMode
  next?: StudyNextStep | null
  onPracticeAgain: () => void
  onPlayOut: (position: { fen: string; lastUci: string | null; origin?: string }) => void
  onClose: () => void
  backLabel?: string
}) {
  const queryClient = useQueryClient()
  const applyReward = useApplyReward(username)
  const loadPosition = useAppStore((state) => state.loadPosition)
  const pushPosition = useAppStore((state) => state.pushPosition)
  const jumpToNode = useAppStore((state) => state.jumpToNode)
  const alignBoardToUserColor = useAppStore((state) => state.alignBoardToUserColor)
  const setDrillSolving = useAppStore((state) => state.setDrillSolving)
  const setTrainerArrows = useAppStore((state) => state.setTrainerArrows)
  const setTrainerHighlights = useAppStore((state) => state.setTrainerHighlights)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const currentNode = useAppStore((state) => state.nodes[state.currentNodeId])

  const [index, setIndex] = useState(0)
  const [phase, setPhase] = useState<Phase>('playing')
  const [played, setPlayed] = useState<Record<number, string>>({})
  const [missed, setMissed] = useState<Record<number, boolean>>({})
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [result, setResult] = useState<StudyCourseReviewResponse | null>(null)
  const [submitError, setSubmitError] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // The move whose comment and marks are on the board once the line is over.
  const [reviewAt, setReviewAt] = useState<number | null>(null)
  const [autoRead, setAutoRead] = useState(readAutoRead)
  const hinted = useRef<Record<number, boolean>>({})
  const expectedNodeId = useRef<string | null>(null)
  const rollbackTimer = useRef<number | null>(null)
  const submitted = useRef(false)
  const requestId = useMemo(
    () => `study:${courseId}:${line.id}:${mode}:${Date.now()}`,
    [courseId, line.id, mode],
  )

  const labels = useMemo(() => moveLabels(line), [line])
  const yours = useMemo(
    () => line.moves.map((move, at) => ({ move, at })).filter((entry) => entry.move.side === 'you'),
    [line.moves],
  )
  const step: StudyCourseMove | undefined = line.moves[index]
  const previous: StudyCourseMove | undefined = index > 0 ? line.moves[index - 1] : undefined
  const ending = useMemo(() => finalPosition(line), [line])

  function clearRollbackTimer() {
    if (rollbackTimer.current !== null) {
      window.clearTimeout(rollbackTimer.current)
      rollbackTimer.current = null
    }
  }

  /** Arrows for the asked move: the author's marks on this board, then the move. */
  function askArrows(at: number): BoardArrow[] {
    const move = line.moves[at]
    if (!move) return []
    return [...authorArrows(line.moves[at - 1]), ...authorArrows(move), moveArrow(move)]
  }

  /** Marked squares for the asked move, the same way: the last move's, then its own. */
  function askHighlights(at: number): BoardHighlight[] {
    return [...authorHighlights(line.moves[at - 1]), ...authorHighlights(line.moves[at])]
  }

  /** Put one move of the finished line back on the board, with what the author said about it. */
  function reviewMove(at: number) {
    const move = line.moves[at]
    if (!move) return
    const after = positionAfter(line, at)
    loadPosition(after.fen, after.lastUci)
    setTrainerArrows(authorArrows(move), after.fen)
    setTrainerHighlights(authorHighlights(move), after.fen)
    setReviewAt(at)
  }

  function begin() {
    stopSpeech()
    clearRollbackTimer()
    hinted.current = {}
    setTrainerArrows([])
    setTrainerHighlights([])
    setReviewAt(null)
    loadPosition(fullFen(line.start_fen))
    alignBoardToUserColor(color)
    expectedNodeId.current = useAppStore.getState().currentNodeId
    setIndex(0)
    setPlayed({})
    setMissed({})
    setFeedback(null)
    setResult(null)
    setSubmitError(false)
    submitted.current = false
    setPhase('playing')
  }

  // Start from the line's first position. A new line or mode remounts this.
  useEffect(() => {
    begin()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per mount
  }, [])

  useEffect(() => {
    setDrillSolving(true)
    return () => {
      clearRollbackTimer()
      stopSpeech()
      setDrillSolving(false)
      setTrainerArrows([])
      setTrainerHighlights([])
    }
  }, [setDrillSolving, setTrainerArrows, setTrainerHighlights])

  // Drive the line: play the opponent's moves, ask for the player's.
  useEffect(() => {
    if (phase !== 'playing') return
    if (!step) {
      const last = line.moves[line.moves.length - 1]
      setTrainerArrows(authorArrows(last), ending.fen)
      setTrainerHighlights(authorHighlights(last), ending.fen)
      setReviewAt(last ? line.moves.length - 1 : null)
      setPhase('finished')
      return
    }
    if (step.side === 'you') {
      expectedNodeId.current = useAppStore.getState().currentNodeId
      setTrainerArrows(mode === 'learn' ? askArrows(index) : [], step.fen)
      setTrainerHighlights(mode === 'learn' ? askHighlights(index) : [], step.fen)
      setPhase('waiting')
      return
    }
    const timer = window.setTimeout(() => {
      const state = useAppStore.getState()
      // Moves made out of turn are ignored: the line resumes from where it was.
      if (expectedNodeId.current && state.currentNodeId !== expectedNodeId.current) {
        jumpToNode(expectedNodeId.current)
      }
      try {
        const board = new Chess(fullFen(step.fen))
        const move = board.move({
          from: step.uci.slice(0, 2),
          to: step.uci.slice(2, 4),
          promotion: step.uci.slice(4) || undefined,
        })
        pushPosition(board.fen(), move.san, step.uci)
      } catch {
        // A move the board cannot play ends the line rather than freezing it.
        setReviewAt(index > 0 ? index - 1 : null)
        setPhase('finished')
        return
      }
      expectedNodeId.current = useAppStore.getState().currentNodeId
      setIndex((value) => value + 1)
    }, OPPONENT_DELAY_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- askArrows reads the same line
  }, [index, jumpToNode, mode, phase, pushPosition, setTrainerArrows, setTrainerHighlights, step])

  // The player's answer: the first move made from the position being asked.
  useEffect(() => {
    if (phase !== 'waiting' || !step || step.side !== 'you') return
    if (rollbackTimer.current !== null) return
    if (!currentNode?.uci || currentNode.parentId !== expectedNodeId.current) return
    if (!sameBoard(useAppStore.getState().nodes[currentNode.parentId ?? '']?.fen ?? '', step.fen))
      return
    const answer = currentNode.uci
    const first = !(index in played)
    if (first) setPlayed((value) => ({ ...value, [index]: answer }))
    if (answer === step.uci) {
      play('right')
      setFeedback({
        kind: 'right',
        text: `${labels[index]} ${step.san}, ${
          first && !missed[index]
            ? hinted.current[index]
              ? 'right, with a hint'
              : 'right'
            : 'now you have it'
        }.`,
      })
      expectedNodeId.current = currentNodeId
      setIndex((value) => value + 1)
      setPhase('playing')
      return
    }
    setMissed((value) => ({ ...value, [index]: true }))
    play('wrong')
    setFeedback({ kind: 'wrong', text: `Not ${currentNode.san ?? answer}. Play ${step.san}.` })
    const back = expectedNodeId.current
    const arrows = askArrows(index)
    const highlights = askHighlights(index)
    const fen = step.fen
    rollbackTimer.current = window.setTimeout(() => {
      rollbackTimer.current = null
      if (back) jumpToNode(back)
      setTrainerArrows(arrows, fen)
      setTrainerHighlights(highlights, fen)
    }, ROLLBACK_DELAY_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new move is an answer
  }, [currentNodeId])

  // Score the pass once it is over.
  useEffect(() => {
    if (phase !== 'finished' || submitted.current) return
    submitted.current = true
    if (yours.length === 0) return
    setSubmitting(true)
    void submitStudyCourseReview(courseId, {
      username,
      line_id: line.id,
      mode,
      moves: yours.map(({ move, at }) => ({
        fen: move.fen,
        expected_uci: move.uci,
        played_uci: played[at] ?? '',
        hinted: Boolean(hinted.current[at]),
      })),
      request_id: requestId,
      tz: browserTimeZone(),
      daily_goal: readDailyGoal(),
    })
      .then((response) => {
        setResult(response)
        invalidateStudyCourses(queryClient, username)
        if (response.reward) void applyReward(response.reward, line.title)
      })
      .catch(() => setSubmitError(true))
      .finally(() => setSubmitting(false))
  }, [
    applyReward,
    courseId,
    line.id,
    line.title,
    mode,
    phase,
    played,
    queryClient,
    requestId,
    username,
    yours,
  ])

  const recalling =
    phase === 'waiting' && step?.side === 'you' && mode === 'practice' && !missed[index]
  const hints = useHint(
    recalling && step ? { fen: step.fen, uci: step.uci } : null,
    step ? index : null,
  )
  function takeHint() {
    hinted.current[index] = true
    hints.ask()
  }

  function reveal() {
    if (!step || step.side !== 'you') return
    setMissed((value) => ({ ...value, [index]: true }))
    if (!(index in played)) setPlayed((value) => ({ ...value, [index]: '' }))
    setTrainerArrows(askArrows(index), step.fen)
    setTrainerHighlights(askHighlights(index), step.fen)
  }

  const shown = step?.side === 'you' && (mode === 'learn' || Boolean(missed[index]))
  const done = yours.filter(({ at }) => at < index).length
  const right = yours.filter(({ at }) => !missed[at] && played[at] === line.moves[at].uci).length
  const recalled = result?.recalled ?? right
  const total = result?.total ?? yours.length
  // What the author said about the move just played, by either side.
  const lastNote = previous?.comment
    ? { label: `${labels[index - 1]} ${previous.san}`, text: previous.comment }
    : null
  const reviewed = reviewAt != null ? line.moves[reviewAt] : undefined
  const reviewNote =
    reviewAt != null && reviewed?.comment
      ? { label: `${labels[reviewAt]} ${reviewed.san}`, text: reviewed.comment }
      : null
  const xpGained = result?.reward?.xp_gained ?? 0

  /**
   * What each Play button reads at step `at`, and the ids that tie the voice to
   * its button. Auto-read reads the opponent's comment first when both are on
   * screen, under the prompt's id so its button can pause it.
   */
  function speechAt(at: number, showPrompt: boolean) {
    const move: StudyCourseMove | undefined = line.moves[at]
    const before: StudyCourseMove | undefined = at > 0 ? line.moves[at - 1] : undefined
    const noteId = `study:${line.id}:note:${at - 1}`
    const noteSpeech = before?.comment ? `${labels[at - 1]} ${before.san}. ${before.comment}` : ''
    const promptId = `study:${line.id}:prompt:${at}`
    const promptSpeech =
      showPrompt && move?.side === 'you'
        ? [`${labels[at]} ${move.san}.`, move.comment ?? ''].join(' ').trim()
        : ''
    const opponentNote = before?.side === 'opponent' ? noteSpeech : ''
    const auto = promptSpeech
      ? { id: promptId, text: [opponentNote, promptSpeech].filter(Boolean).join(' ') }
      : opponentNote
        ? { id: noteId, text: opponentNote }
        : null
    return { noteId, noteSpeech, promptId, promptSpeech, auto }
  }

  const { noteId, noteSpeech, promptId, promptSpeech, auto: stepAuto } = speechAt(index, shown)
  const reviewId = `study:${line.id}:review:${reviewAt ?? -1}`
  const reviewSpeech = reviewNote ? `${reviewNote.label}. ${reviewNote.text}` : ''
  // Castling and "your knight" read from the side the line is played for.
  const voice = { side: color }

  // Auto-read: each new explanation is read once, as it appears.
  let auto: { id: string; text: string } | null = null
  if (phase === 'finished') {
    if (reviewSpeech) auto = { id: reviewId, text: reviewSpeech }
  } else if (phase === 'waiting') {
    auto = stepAuto
  }
  const autoKey = auto ? `${auto.id}|${auto.text}` : ''
  useEffect(() => {
    if (!autoRead || !auto) return
    void speak(auto.id, auto.text, voice)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key names the text
  }, [autoRead, autoKey])

  // Look ahead: fetch what this step and the next two will read, so Play (or
  // Auto-read on the next move) starts from memory instead of waiting on the
  // voice. Silent, and a clip that fails is only asked for again on Play.
  const missedHere = Boolean(missed[index])
  useEffect(() => {
    if (phase === 'finished') return
    const texts = new Set<string>()
    for (let at = index; at < Math.min(line.moves.length, index + 3); at += 1) {
      const ahead = speechAt(at, mode === 'learn' || (at === index && missedHere))
      if (autoRead) {
        if (ahead.auto) texts.add(ahead.auto.text)
      } else {
        if (ahead.noteSpeech) texts.add(ahead.noteSpeech)
        if (ahead.promptSpeech) texts.add(ahead.promptSpeech)
      }
    }
    for (const text of texts) void prefetchSpeech(text, voice)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- speechAt reads only these
  }, [autoRead, color, index, line, missedHere, mode, phase])

  function toggleAutoRead() {
    const next = !autoRead
    writeAutoRead(next)
    setAutoRead(next)
    if (!next) stopSpeech()
  }

  return (
    <div className="study-trainer" data-mode={mode}>
      <div className="study-trainer__head">
        <Button onClick={onClose} type="button" variant="ghost">
          <ArrowLeft aria-hidden="true" size={14} /> {backLabel}
        </Button>
        <button
          aria-pressed={autoRead}
          className="study-trainer__autoread"
          onClick={toggleAutoRead}
          title="Read each explanation aloud as it appears"
          type="button"
        >
          {autoRead ? (
            <Volume2 aria-hidden="true" size={13} />
          ) : (
            <VolumeX aria-hidden="true" size={13} />
          )}
          Auto-read
        </button>
        <span className="study-trainer__mode">{mode === 'learn' ? 'Learn' : 'Practice'}</span>
      </div>
      <strong className="study-trainer__title">{line.title}</strong>
      <span className="muted study-trainer__course">{courseTitle}</span>

      <ol aria-label="Your moves in this line" className="line-trainer__dots">
        {yours.map(({ move, at }) => {
          const state =
            at < index ? (missed[at] ? 'missed' : 'right') : at === index ? 'current' : 'todo'
          return (
            <li
              aria-current={state === 'current' ? 'step' : undefined}
              data-state={state}
              key={`${at}:${move.uci}`}
              title={`${labels[at]} ${move.san}`}
            >
              <span>
                {labels[at]} {at < index || shown ? move.san : '?'}
              </span>
            </li>
          )
        })}
      </ol>

      <p aria-live="polite" className="sr-only-inline">
        {feedback?.text ?? ''}
      </p>

      {feedback ? (
        <p className="line-trainer__feedback" data-kind={feedback.kind}>
          {feedback.kind === 'right' ? <Check size={14} /> : <X size={14} />}
          <span>{feedback.text}</span>
        </p>
      ) : null}

      {lastNote && phase !== 'finished' ? (
        <div className="study-trainer__note">
          <MessageSquareText aria-hidden="true" size={14} />
          <p>
            <strong>{lastNote.label}</strong> {lastNote.text}
          </p>
          <SpeakButton compact id={noteId} side={color} text={noteSpeech} />
        </div>
      ) : null}

      {phase === 'finished' ? (
        <div className="study-trainer__finish">
          {line.moves.length > 0 ? (
            <div className="study-trainer__review">
              <ol aria-label="Step through the line" className="study-trainer__steps">
                {line.moves.map((move, at) => (
                  <li key={`${at}:${move.uci}`}>
                    <button
                      aria-current={at === reviewAt ? 'step' : undefined}
                      className="study-trainer__step"
                      data-side={move.side}
                      onClick={() => reviewMove(at)}
                      type="button"
                    >
                      {labels[at]} {move.san}
                    </button>
                  </li>
                ))}
              </ol>
              <div className="study-trainer__stepper">
                <Button
                  disabled={reviewAt == null || reviewAt <= 0}
                  onClick={() => reviewMove((reviewAt ?? 0) - 1)}
                  type="button"
                  variant="ghost"
                >
                  <ChevronLeft aria-hidden="true" size={14} /> Previous
                </Button>
                <Button
                  disabled={reviewAt == null || reviewAt >= line.moves.length - 1}
                  onClick={() => reviewMove((reviewAt ?? -1) + 1)}
                  type="button"
                  variant="ghost"
                >
                  Next <ChevronRight aria-hidden="true" size={14} />
                </Button>
              </div>
              <div className="study-trainer__note">
                <MessageSquareText aria-hidden="true" size={14} />
                <p>
                  {reviewNote ? (
                    <>
                      <strong>{reviewNote.label}</strong> {reviewNote.text}
                    </>
                  ) : reviewed ? (
                    <>
                      <strong>
                        {labels[reviewAt ?? 0]} {reviewed.san}
                      </strong>{' '}
                      <span className="muted">No comment on this move.</span>
                    </>
                  ) : null}
                </p>
                {reviewNote ? (
                  <SpeakButton compact id={reviewId} side={color} text={reviewSpeech} />
                ) : null}
              </div>
            </div>
          ) : null}
          {submitting && !result ? <p className="muted">Scoring...</p> : null}
          {submitError ? (
            <p className="study-trainer__error">The result could not be saved this time.</p>
          ) : null}
          {yours.length > 0 ? (
            <div className="result-hero">
              <Medal
                earned={total > 0 && recalled === total}
                emblem="book"
                label={`${recalled} of ${total} moves right`}
                progress={total ? recalled / total : 0}
                size={56}
              />
              <ol aria-label="Your moves" className="result-rank">
                {yours.map(({ move, at }, order) => {
                  const ok = !missed[at] && played[at] === move.uci
                  return (
                    <li data-shade={order % 2 ? 'dark' : 'light'} key={`${at}:${move.uci}`}>
                      {ok ? <TitlePiece title="Pawn" /> : null}
                      <span className="sr-only-inline">
                        Move {order + 1}: {ok ? 'right' : 'missed'}
                      </span>
                    </li>
                  )
                })}
              </ol>
            </div>
          ) : null}
          <p className="study-trainer__score">
            <strong>
              {recalled.toLocaleString()} / {total.toLocaleString()}
            </strong>{' '}
            {mode === 'learn' ? 'played without a miss.' : 'from memory.'}
            {xpGained > 0 ? (
              <span className="study-trainer__xp">+{xpGained.toLocaleString()} XP</span>
            ) : null}
          </p>
          {result ? (
            <p className="muted">
              {result.due_moves > 0
                ? `${result.due_moves.toLocaleString()} moves in this line come back for review.`
                : 'Nothing in this line is due now.'}
            </p>
          ) : null}
          <div className="study-trainer__actions">
            {next ? (
              <Button onClick={next.onSelect} type="button" variant="primary">
                {next.label}
              </Button>
            ) : null}
            <Button onClick={onPracticeAgain} type="button">
              <RotateCcw aria-hidden="true" size={14} /> Practice again
            </Button>
            <Button
              onClick={() =>
                onPlayOut({ ...ending, origin: `Course: ${courseTitle}, ${line.title}` })
              }
              type="button"
            >
              <Swords aria-hidden="true" size={14} /> Play it out vs Stockfish
            </Button>
          </div>
        </div>
      ) : step?.side === 'you' ? (
        <div className="study-trainer__prompt">
          <p className="line-trainer__ask">
            <strong>{labels[index]} ?</strong>{' '}
            {shown ? (
              <>
                Play <strong>{step.san}</strong>.
              </>
            ) : (
              'Your move, from memory.'
            )}
            {shown ? <SpeakButton compact id={promptId} side={color} text={promptSpeech} /> : null}
          </p>
          {shown ? (
            step.comment ? (
              <p className="study-trainer__why">{step.comment}</p>
            ) : null
          ) : (
            <div className="line-trainer__help">
              <HintControl hints={{ ...hints, ask: takeHint }} />
              <Button onClick={reveal} type="button" variant="ghost">
                <Eye aria-hidden="true" size={14} /> Show me
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="study-trainer__prompt">
          <p className="muted">Your opponent is moving...</p>
        </div>
      )}

      <div className="trainer-actions trainer-actions--quiet">
        <ExploreButton />
      </div>
      <p className="muted line-trainer__count">
        {done.toLocaleString()} / {yours.length.toLocaleString()} moves
        {phase !== 'finished' ? (
          <button className="line-trainer__restart" onClick={begin} type="button">
            <RotateCcw aria-hidden="true" size={12} /> Restart
          </button>
        ) : null}
      </p>
    </div>
  )
}
