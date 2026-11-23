import { useEffect, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'

import { HintControl } from '@/components/training/hint-control'
import { ExploreButton } from '@/components/ui/explore-button'
import { Medal, TitlePiece } from '@/components/training/trophies'
import { useHint } from '@/hooks/use-hint'
import { play } from '@/lib/sound'
import { Button } from '@/components/ui/button'
import { useApplyReward, useTrainingProfile } from '@/hooks/use-training'
import { api } from '@/lib/api'
import { PLAY_ARROW_COLOR } from '@/lib/analysis/board-guidance'
import { formatRushTime, rushVerdict } from '@/lib/training/rush'
import { browserTimeZone, readDailyGoal } from '@/lib/training/progress'
import type { RushQuestion, RushResult, RushSet } from '@/lib/training/types'
import { useAppStore } from '@/store/app-store'
import { useTrainingStore } from '@/store/training-store'

const CLOCK_SQUARES = 12

type Phase = 'idle' | 'loading' | 'running' | 'scoring' | 'done' | 'empty' | 'error'

const WRONG_PAUSE_MS = 1100
const RIGHT_PAUSE_MS = 250

function fullFen(fen: string) {
  return fen.split(' ').length >= 6 ? fen : `${fen} 0 1`
}

/**
 * Opening Rush: every move of the player's repertoire, against the clock.
 *
 * Puzzle Rush's shape — three minutes, three lives, a best to beat — asked
 * from the player's own repertoire, easiest moves first. A miss shows the
 * right move for a moment and sends that move back to the review queue; the
 * run is scored on the server from the moves actually played.
 */
export function OpeningRush({ username, onBegin }: { username: string; onBegin?: () => void }) {
  const profile = useTrainingProfile(username).data
  const applyReward = useApplyReward(username)
  const loadPosition = useAppStore((state) => state.loadPosition)
  const alignBoardToUserColor = useAppStore((state) => state.alignBoardToUserColor)
  const setDrillSolving = useAppStore((state) => state.setDrillSolving)
  const setTrainerArrows = useAppStore((state) => state.setTrainerArrows)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const session = useTrainingStore((state) => state.session)
  const endSession = useTrainingStore((state) => state.endSession)
  const celebrate = useTrainingStore((state) => state.celebrate)

  const [phase, setPhase] = useState<Phase>('idle')
  const [set, setSet] = useState<RushSet | null>(null)
  const [index, setIndex] = useState(0)
  const [score, setScore] = useState(0)
  const [lives, setLives] = useState(3)
  const [remaining, setRemaining] = useState(0)
  const [flash, setFlash] = useState<{ kind: 'right' | 'wrong'; text: string } | null>(null)
  const [missed, setMissed] = useState<RushQuestion[]>([])
  const [result, setResult] = useState<RushResult | null>(null)
  const answers = useRef<{ fen: string; played_uci: string }[]>([])
  const rootId = useRef<string | null>(null)
  const endsAt = useRef(0)
  const locked = useRef(false)
  const runId = useRef('')
  // The clock and a last wrong answer can both end a run in the same tick.
  const finishing = useRef(false)

  const question = set?.questions[index]
  // A hint costs clock, which is Rush's own price.
  const hints = useHint(
    phase === 'running' && question ? { fen: question.fen, uci: question.answer_uci } : null,
    question?.fen ?? null,
  )

  function ask(next: RushSet, at: number) {
    const item = next.questions[at]
    if (!item) {
      void finish()
      return
    }
    loadPosition(fullFen(item.fen), item.last_move_uci)
    alignBoardToUserColor(item.side_to_move)
    rootId.current = useAppStore.getState().currentNodeId
    setTrainerArrows([])
    setIndex(at)
    locked.current = false
  }

  async function start() {
    endSession()
    onBegin?.()
    setPhase('loading')
    try {
      const response = await api.get<RushSet>('/api/training/rush', {
        params: { username, seed: Math.floor(Math.random() * 1_000_000) },
      })
      const next = response.data
      if (!next.questions.length) {
        setPhase('empty')
        return
      }
      answers.current = []
      finishing.current = false
      runId.current = `${Date.now()}`
      setSet(next)
      setScore(0)
      setLives(next.lives)
      setMissed([])
      setResult(null)
      setFlash(null)
      endsAt.current = Date.now() + next.seconds * 1000
      setRemaining(next.seconds * 1000)
      setDrillSolving(true)
      setPhase('running')
      ask(next, 0)
    } catch {
      setPhase('error')
    }
  }

  async function finish() {
    if (finishing.current) return
    finishing.current = true
    locked.current = true
    setPhase('scoring')
    setDrillSolving(false)
    setTrainerArrows([])
    try {
      const response = await api.post<RushResult>('/api/training/rush/result', {
        username,
        answers: answers.current,
        request_id: runId.current,
        tz: browserTimeZone(),
        goal: readDailyGoal(),
      })
      setResult(response.data)
      void applyReward(response.data, 'Opening Rush')
      if (response.data.new_best) {
        celebrate({
          kind: 'level',
          title: `New best: ${response.data.score}`,
          detail: 'Opening Rush',
          visual: { kind: 'icon', name: 'bolt' },
        })
      }
      setPhase('done')
    } catch {
      setPhase('error')
    }
  }

  // The clock.
  useEffect(() => {
    if (phase !== 'running') return
    const timer = window.setInterval(() => {
      const left = endsAt.current - Date.now()
      setRemaining(Math.max(0, left))
      if (left <= 0) void finish()
    }, 200)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- finish reads refs; the clock only needs the phase
  }, [phase])

  // A course session taking the board ends the run where it stands.
  useEffect(() => {
    if (session && phase === 'running') void finish()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new session matters
  }, [session])

  useEffect(
    () => () => {
      setDrillSolving(false)
      setTrainerArrows([])
    },
    [setDrillSolving, setTrainerArrows],
  )

  // The answer: the first move made from the question's position.
  useEffect(() => {
    if (phase !== 'running' || !set || !question || locked.current) return
    const node = useAppStore.getState().nodes[currentNodeId]
    if (!node?.uci || node.parentId !== rootId.current) return
    locked.current = true
    answers.current.push({ fen: question.fen, played_uci: node.uci })
    if (node.uci === question.answer_uci) {
      setScore((value) => value + 1)
      play('right')
      setFlash({ kind: 'right', text: `${question.answer_san}, right` })
      window.setTimeout(() => ask(set, index + 1), RIGHT_PAUSE_MS)
      return
    }
    const left = lives - 1
    setLives(left)
    setMissed((previous) => [...previous, question])
    play('wrong')
    setFlash({ kind: 'wrong', text: `${question.answer_san} was the move` })
    if (rootId.current) useAppStore.getState().jumpToNode(rootId.current)
    setTrainerArrows([
      {
        startSquare: question.answer_uci.slice(0, 2),
        endSquare: question.answer_uci.slice(2, 4),
        color: PLAY_ARROW_COLOR,
      },
    ])
    window.setTimeout(() => {
      if (left <= 0) void finish()
      else ask(set, index + 1)
    }, WRONG_PAUSE_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new move is an answer
  }, [currentNodeId])

  const best = profile?.rush_best ?? 0
  const total = set ? set.seconds * 1000 : 1

  if (phase === 'running' || phase === 'scoring') {
    return (
      <section aria-label="Opening Rush" className="rush rush--running">
        <div className="rush__hud">
          <span className="rush__score" aria-live="polite">
            {score}
          </span>
          {/* Lives are kings: a lost one is laid down, the way a player resigns. */}
          <span className="rush__lives" role="img" aria-label={`${lives} lives left`}>
            {Array.from({ length: set?.lives ?? 3 }, (_, i) => (
              <span className="rush__life" data-lost={i >= lives || undefined} key={i}>
                <TitlePiece title="King" />
              </span>
            ))}
          </span>
          <span className="rush__time">{formatRushTime(remaining)}</span>
        </div>
        {/* The clock as a rank of twelve squares, one per 15 seconds, emptying as time runs. */}
        <span aria-hidden="true" className="rush__rank">
          {Array.from({ length: CLOCK_SQUARES }, (_, at) => (
            <span
              data-lit={at < Math.ceil((remaining / total) * CLOCK_SQUARES) || undefined}
              data-shade={at % 2 ? 'dark' : 'light'}
              data-last={remaining > 0 && remaining <= total / CLOCK_SQUARES ? true : undefined}
              key={at}
            />
          ))}
        </span>
        {question ? (
          <p className="rush__prompt">
            {question.side_to_move === 'white' ? 'White' : 'Black'} to move
            {question.line_name ? <span className="muted"> · {question.line_name}</span> : null}
          </p>
        ) : null}
        <p aria-live="polite" className="rush__flash" data-kind={flash?.kind}>
          {phase === 'scoring'
            ? remaining <= 0
              ? 'Time!'
              : 'Out of lives'
            : (flash?.text ?? 'Play your repertoire move.')}
        </p>
        {phase === 'running' ? <HintControl hints={hints} /> : null}
      </section>
    )
  }

  if (phase === 'done' && result) {
    return (
      <section aria-label="Opening Rush result" className="rush rush--done">
        <div className="result-hero">
          <Medal
            earned={result.new_best}
            emblem="bolt"
            label={`${result.score} moves, best ${result.best}`}
            progress={result.best ? Math.min(1, result.score / result.best) : 0}
            size={72}
          />
          <div className="result-hero__text">
            <span className="result-hero__score">
              {result.score}
              {result.new_best ? <span className="rush__best-badge">New best</span> : null}
            </span>
            <span className="muted">{rushVerdict(result.score, result.best)}</span>
          </div>
        </div>
        {missed.length ? (
          <ul aria-label="Moves you missed" className="rush__missed">
            {missed.map((item) => (
              <li key={item.fen}>
                <b>{item.answer_san}</b>
                <span className="muted">
                  {item.line_name ?? (item.color === 'white' ? 'As White' : 'As Black')}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {result.requeued ? (
          <p className="muted rush__note">
            {result.requeued.toLocaleString()} missed{' '}
            {result.requeued === 1 ? 'move is' : 'moves are'} back in your reviews.
          </p>
        ) : null}
        <div className="trainer-actions">
          <Button onClick={() => void start()} type="button" variant="primary">
            <RotateCcw size={14} /> Go again
          </Button>
          <ExploreButton />
        </div>
      </section>
    )
  }

  return (
    <section aria-label="Opening Rush" className="rush">
      <div className="rush__intro">
        {/* The arc is the best run toward the next Rush badge: Quick draw at 10, Lightning at 25. */}
        <Medal
          earned={best >= 25}
          emblem="bolt"
          label={best >= 25 ? 'Lightning earned' : `Best ${best} of ${best >= 10 ? 25 : 10}`}
          progress={best >= 10 ? best / 25 : best / 10}
          size={48}
        />
        <div>
          <strong>Opening Rush</strong>
          <span className="muted">
            Your repertoire against the clock: 3 minutes, 3 lives.{' '}
            {best
              ? best >= 25
                ? `Your best is ${best}.`
                : `Your best is ${best}. ${best >= 10 ? 'Lightning at 25.' : 'Quick draw at 10.'}`
              : 'Set your first score.'}
          </span>
        </div>
        <Button
          disabled={phase === 'loading'}
          onClick={() => void start()}
          type="button"
          variant="primary"
        >
          {phase === 'loading' ? 'Loading…' : 'Start the Rush'}
        </Button>
      </div>
      {phase === 'empty' ? (
        <p className="muted rush__note">
          No repertoire moves to ask yet. Learn a line in the opening course first.
        </p>
      ) : phase === 'error' ? (
        <p className="muted rush__note" role="alert">
          Couldn't reach the server. Check your connection and try again.
        </p>
      ) : null}
    </section>
  )
}
