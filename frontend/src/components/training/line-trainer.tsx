import { useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { Check, Crosshair, Eye, RotateCcw, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { HintControl } from '@/components/training/hint-control'
import { ExploreButton } from '@/components/ui/explore-button'
import { Medal, TitlePiece } from '@/components/training/trophies'
import { useHint } from '@/hooks/use-hint'
import { play } from '@/lib/sound'
import { useApplyReward } from '@/hooks/use-training'
import { api } from '@/lib/api'
import {
  explainStep,
  explainTrap,
  lineStakes,
  lineTitle,
  numberedMove,
} from '@/lib/training/course'
import { PLAY_ARROW_COLOR } from '@/lib/analysis/board-guidance'
import { browserTimeZone, readDailyGoal } from '@/lib/training/progress'
import type {
  LineReviewResponse,
  RepertoireLine,
  RepertoireStep,
  YourStep,
} from '@/lib/training/types'
import { useAppStore } from '@/store/app-store'

const HINT_ARROW = PLAY_ARROW_COLOR
const OPPONENT_DELAY_MS = 450

type Phase = 'playing' | 'waiting' | 'finished'

function fullFen(fen: string) {
  return fen.split(' ').length >= 6 ? fen : `${fen} 0 1`
}

function sameBoard(a: string, b: string) {
  return a.split(' ').slice(0, 4).join(' ') === b.split(' ').slice(0, 4).join(' ')
}

function arrowFor(uci: string, color = HINT_ARROW) {
  return [{ startSquare: uci.slice(0, 2), endSquare: uci.slice(2, 4), color }]
}

/**
 * One line of the repertoire, played on the real board, MoveTrainer style.
 *
 * The opponent's moves play themselves; the player's are asked for. In Learn
 * mode each of the player's moves is shown with an arrow and a reason, and the
 * player plays it to continue; in Practice mode nothing is shown until they
 * have tried. A wrong move is taken back and the right one shown, and the
 * player plays that before the line goes on — the correction is made with the
 * hand, not only read. Only the first try at each move is scored, and the
 * server scores it against the line, not against what this page claims.
 */
export function LineTrainer({
  username,
  color,
  timeClass,
  line,
  mode,
  onBegin,
  onFinished,
}: {
  username: string
  color: 'white' | 'black'
  timeClass: string
  line: RepertoireLine
  mode: 'learn' | 'practice'
  onBegin?: () => void
  onFinished?: (result: LineReviewResponse | null) => void
}) {
  const loadPosition = useAppStore((state) => state.loadPosition)
  const pushPosition = useAppStore((state) => state.pushPosition)
  const jumpToNode = useAppStore((state) => state.jumpToNode)
  const alignBoardToUserColor = useAppStore((state) => state.alignBoardToUserColor)
  const setDrillSolving = useAppStore((state) => state.setDrillSolving)
  const setTrainerArrows = useAppStore((state) => state.setTrainerArrows)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const currentNode = useAppStore((state) => state.nodes[state.currentNodeId])
  const applyReward = useApplyReward(username)

  const [index, setIndex] = useState(0)
  const [phase, setPhase] = useState<Phase>('playing')
  const [played, setPlayed] = useState<Record<string, string>>({})
  const [missed, setMissed] = useState<Record<string, boolean>>({})
  const [feedback, setFeedback] = useState<{ kind: 'right' | 'wrong'; text: string } | null>(null)
  const hinted = useRef<Record<string, boolean>>({})
  const [result, setResult] = useState<LineReviewResponse | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const expectedNodeId = useRef<string | null>(null)
  // Scored once per pass: a failed request is reported, never retried in a loop.
  const submitted = useRef(false)
  const requestId = useMemo(() => `line:${line.id}:${mode}:${Date.now()}`, [line.id, mode])

  const yours = useMemo(
    () => line.moves.filter((step): step is YourStep => step.side === 'you'),
    [line.moves],
  )
  const step: RepertoireStep | undefined = line.moves[index]
  const lastOpponent = index > 0 ? line.moves[index - 1] : undefined
  const trapNote = lastOpponent ? explainTrap(lastOpponent) : null

  // Start (or restart) the line from its first position.
  useEffect(() => {
    onBegin?.()
    loadPosition(fullFen(line.moves[0].fen))
    alignBoardToUserColor(color)
    expectedNodeId.current = useAppStore.getState().currentNodeId
    setIndex(0)
    setPlayed({})
    setMissed({})
    setFeedback(null)
    setResult(null)
    submitted.current = false
    setPhase('playing')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new line or mode restarts; nothing else does
  }, [line.id, mode])

  useEffect(() => {
    setDrillSolving(true)
    return () => {
      setDrillSolving(false)
      setTrainerArrows([])
    }
  }, [setDrillSolving, setTrainerArrows])

  // Drive the line: play the opponent's moves, ask for the player's.
  useEffect(() => {
    if (phase !== 'playing') return
    if (!step) {
      setTrainerArrows([])
      setPhase('finished')
      return
    }
    if (step.side === 'you') {
      expectedNodeId.current = useAppStore.getState().currentNodeId
      setTrainerArrows(mode === 'learn' ? arrowFor(step.uci) : [])
      setPhase('waiting')
      return
    }
    const timer = window.setTimeout(() => {
      const state = useAppStore.getState()
      // Moves made out of turn are ignored: the line resumes from where it was.
      if (expectedNodeId.current && state.currentNodeId !== expectedNodeId.current) {
        jumpToNode(expectedNodeId.current)
      }
      const board = new Chess(fullFen(step.fen))
      const move = board.move({
        from: step.uci.slice(0, 2),
        to: step.uci.slice(2, 4),
        promotion: step.uci.slice(4) || undefined,
      })
      pushPosition(board.fen(), move.san, step.uci)
      expectedNodeId.current = useAppStore.getState().currentNodeId
      setIndex((value) => value + 1)
    }, OPPONENT_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [index, jumpToNode, mode, phase, pushPosition, setTrainerArrows, step])

  // The player's answer: the first move made from the position being asked.
  useEffect(() => {
    if (phase !== 'waiting' || !step || step.side !== 'you') return
    if (!currentNode?.uci || currentNode.parentId !== expectedNodeId.current) return
    if (!sameBoard(useAppStore.getState().nodes[currentNode.parentId ?? '']?.fen ?? '', step.fen))
      return
    const answer = currentNode.uci
    const first = !(step.fen in played)
    if (first) setPlayed((previous) => ({ ...previous, [step.fen]: answer }))
    if (answer === step.uci) {
      play('right')
      setFeedback({
        kind: 'right',
        text: `${numberedMove(step)}, ${
          first && !missed[step.fen]
            ? hinted.current[step.fen]
              ? 'right, with a hint'
              : 'right'
            : 'now you have it'
        }.`,
      })
      setTrainerArrows([])
      expectedNodeId.current = currentNodeId
      setIndex((value) => value + 1)
      setPhase('playing')
      return
    }
    setMissed((previous) => ({ ...previous, [step.fen]: true }))
    play('wrong')
    setFeedback({
      kind: 'wrong',
      text: `Not ${currentNode.san ?? answer}. Play ${step.san}.`,
    })
    const back = expectedNodeId.current
    const timer = window.setTimeout(() => {
      if (back) jumpToNode(back)
      setTrainerArrows(arrowFor(step.uci))
    }, 600)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new move is an answer
  }, [currentNodeId])

  // Score the pass once it is over.
  useEffect(() => {
    if (phase !== 'finished' || submitted.current) return
    submitted.current = true
    setSubmitting(true)
    void api
      .post<LineReviewResponse>('/api/training/repertoire/review', {
        username,
        color,
        time_class: timeClass,
        line_id: line.id,
        mode,
        played,
        request_id: requestId,
        tz: browserTimeZone(),
        goal: readDailyGoal(),
      })
      .then((response) => {
        setResult(response.data)
        void applyReward(response.data, lineTitle(line))
        onFinished?.(response.data)
      })
      .catch(() => onFinished?.(null))
      .finally(() => setSubmitting(false))
  }, [applyReward, color, line, mode, onFinished, phase, played, requestId, timeClass, username])

  // Hints while recalling: the kind of move, then the piece. The move itself
  // is "Show me", which counts as a miss; a hinted move still counts.
  const recalling =
    phase === 'waiting' && step?.side === 'you' && mode !== 'learn' && !missed[step.fen]
  const hints = useHint(
    recalling && step ? { fen: step.fen, uci: step.uci } : null,
    step?.fen ?? null,
  )
  function takeHint() {
    if (step) hinted.current[step.fen] = true
    hints.ask()
  }

  function reveal() {
    if (!step || step.side !== 'you') return
    setMissed((previous) => ({ ...previous, [step.fen]: true }))
    if (!(step.fen in played)) setPlayed((previous) => ({ ...previous, [step.fen]: '' }))
    setTrainerArrows(arrowFor(step.uci))
  }

  const done = yours.filter((item) => item.fen in played && line.moves.indexOf(item) < index).length

  return (
    <div className="line-trainer" data-mode={mode}>
      <div className="line-trainer__head">
        <span className="line-trainer__mode">{mode === 'learn' ? 'Learn' : 'Practice'}</span>
        <strong className="line-trainer__title">{lineTitle(line)}</strong>
      </div>
      {/* Why this line: the course list says it per row, but the session
          replaces the list, and the reason to learn it should travel along. */}
      <p className="muted line-trainer__stakes">{lineStakes(line)}</p>

      <ol aria-label="Your moves in this line" className="line-trainer__dots">
        {yours.map((item) => {
          const position = line.moves.indexOf(item)
          const state =
            position < index
              ? missed[item.fen]
                ? 'missed'
                : 'right'
              : position === index
                ? 'current'
                : 'todo'
          return (
            <li
              aria-current={state === 'current' ? 'step' : undefined}
              data-state={state}
              key={`${item.fen}:${item.uci}`}
              title={numberedMove(item)}
            >
              <span>
                {numberedMove(item)}
                {state === 'missed' ? ', missed' : state === 'right' ? ', right' : ''}
              </span>
            </li>
          )
        })}
      </ol>

      {/* One announcer that never unmounts: the branches below swap on every
          move, and a live region that remounts is never read. */}
      <p aria-live="polite" className="sr-only-inline">
        {feedback?.text ?? ''}
      </p>

      {phase === 'finished' ? (
        <div className="line-trainer__finish">
          {submitting && !result ? <p className="muted">Scoring…</p> : null}
          {result ? (
            <>
              <div className="result-hero">
                <Medal
                  earned={result.misses === 0}
                  emblem={line.changes > 0 ? 'shield' : line.traps > 0 ? 'crosshair' : 'book'}
                  label={`${yours.length - result.misses} of ${yours.length} moves right`}
                  progress={yours.length ? (yours.length - result.misses) / yours.length : 0}
                  size={56}
                />
                <ol aria-label="Your moves" className="result-rank">
                  {result.results.map((move, at) => (
                    <li data-shade={at % 2 ? 'dark' : 'light'} key={`${move.fen}:${move.uci}`}>
                      {move.correct ? <TitlePiece title="Pawn" /> : null}
                      <span className="sr-only-inline">
                        Move {at + 1}: {move.correct ? 'right' : 'missed'}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
              <p className="line-trainer__verdict">
                {mode === 'learn'
                  ? result.misses === 0
                    ? 'Line learned.'
                    : 'Done, with misses. Run it once more without one to learn it.'
                  : result.misses === 0
                    ? 'Every move from memory.'
                    : `${(yours.length - result.misses).toLocaleString()} of ${yours.length.toLocaleString()} from memory.`}
              </p>
              <p className="muted line-trainer__next">
                {mode === 'learn'
                  ? 'First review in 4 hours.'
                  : result.misses === 0
                    ? 'Next review is further out.'
                    : 'The moves you missed come back in 4 hours.'}
              </p>
            </>
          ) : null}
        </div>
      ) : step?.side === 'you' ? (
        <div className="line-trainer__prompt">
          {trapNote ? (
            <p className="line-trainer__trap">
              <Crosshair aria-hidden="true" size={14} /> {trapNote}
            </p>
          ) : null}
          {feedback ? (
            <p className="line-trainer__feedback" data-kind={feedback.kind}>
              {feedback.kind === 'right' ? <Check size={14} /> : <X size={14} />}
              <span>{feedback.text}</span>
            </p>
          ) : null}
          <p className="line-trainer__ask">
            <strong>{numberedMove({ ...step, san: '?' })}</strong>{' '}
            {mode === 'learn' || missed[step.fen] ? (
              <>
                Play <strong>{step.san}</strong>.
              </>
            ) : (
              'Your move, from memory.'
            )}
          </p>
          {mode === 'learn' || missed[step.fen] ? (
            <p className="muted line-trainer__why">{explainStep(step)}</p>
          ) : (
            <div className="line-trainer__help">
              <HintControl hints={{ ...hints, ask: takeHint }} />
              <Button onClick={reveal} type="button" variant="ghost">
                <Eye size={14} /> Show me
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="line-trainer__prompt">
          {feedback ? (
            <p className="line-trainer__feedback" data-kind={feedback.kind}>
              {feedback.kind === 'right' ? <Check size={14} /> : <X size={14} />}
              <span>{feedback.text}</span>
            </p>
          ) : null}
          <p className="muted">Your opponent is moving…</p>
        </div>
      )}

      <div className="trainer-actions trainer-actions--quiet">
        <ExploreButton />
      </div>
      <p className="muted line-trainer__count">
        {done.toLocaleString()} / {yours.length.toLocaleString()} moves
        {phase !== 'finished' ? (
          <button
            className="line-trainer__restart"
            onClick={() => {
              loadPosition(fullFen(line.moves[0].fen))
              expectedNodeId.current = useAppStore.getState().currentNodeId
              setIndex(0)
              setPlayed({})
              setMissed({})
              setFeedback(null)
              setPhase('playing')
            }}
            type="button"
          >
            <RotateCcw size={12} /> Restart
          </button>
        ) : null}
      </p>
    </div>
  )
}
