import { useEffect, useRef, useState } from 'react'
import { ArrowRight, RotateCcw } from 'lucide-react'

import { DrillContinuation } from '@/components/improvement/drill-continuation'
import { HintControl } from '@/components/training/hint-control'
import { useHint } from '@/hooks/use-hint'
import type { Hint } from '@/lib/training/hints'
import { Emblem, Medal, TitlePiece } from '@/components/training/trophies'
import { revealSection } from '@/components/ui/collapsible-section'
import { play } from '@/lib/sound'
import { Button } from '@/components/ui/button'
import { formatGameDate } from '@/lib/format-date'
import { useApplyReward, useTrainingProfile } from '@/hooks/use-training'
import { api } from '@/lib/api'
import {
  punishLesson,
  punishPrompt,
  punishSummary,
  threatLesson,
  threatPrompt,
  threatSummary,
} from '@/lib/training/rush'
import { browserTimeZone, readDailyGoal } from '@/lib/training/progress'
import type {
  PunishAnswer,
  PunishQuestion,
  ThreatAnswer,
  ThreatQuestion,
  TrainingReward,
} from '@/lib/training/types'
import { useAppStore } from '@/store/app-store'
import { useTrainingStore } from '@/store/training-store'

type Phase = 'idle' | 'loading' | 'asking' | 'answered' | 'done' | 'empty' | 'error'

/** Whose mistake is asked: yours (find their punishment) or theirs (find yours). */
export type BlunderMode = 'threats' | 'punish'

const MODE_STORAGE = 'chessgod.blunder-check.mode'

function readMode(): BlunderMode {
  try {
    return window.localStorage.getItem(MODE_STORAGE) === 'punish' ? 'punish' : 'threats'
  } catch {
    return 'threats'
  }
}

function writeMode(mode: BlunderMode) {
  try {
    window.localStorage.setItem(MODE_STORAGE, mode)
  } catch {
    // A blocked store only loses the remembered side.
  }
}

/** Opens Blunder Check on the given side, from anywhere in the app. */
export function openBlunderCheck(mode: BlunderMode) {
  writeMode(mode)
  revealSection('review-threats')
}

function fullFen(fen: string) {
  return fen.split(' ').length >= 6 ? fen : `${fen} 0 1`
}

/** One question either side, in the shape the set is run in. */
type Asked = {
  position_id: number
  fen: string
  player_color: 'white' | 'black'
  last_uci: string
  prompt: string
  context: string
  played_at: string
  game_url: string
  again?: boolean
}

type Scored = TrainingReward & { correct: boolean; answer_uci: string; lesson: string }

const MODES = {
  threats: {
    label: 'Your mistakes',
    emblem: 'eye',
    title: 'Blunder Check',
    intro:
      '10 of your own big mistakes. Find the move that punishes each one. Misses come back tomorrow.',
    waiting: 'Play their move on the board.',
    found: 'spotted',
    get: '/api/training/threats',
    post: '/api/training/threats/answer',
    rewardTitle: (correct: boolean) => (correct ? 'Threat spotted' : 'Blunder Check'),
    ask: (item: ThreatQuestion): Asked => ({
      ...item,
      last_uci: item.your_move_uci,
      prompt: threatPrompt(item),
      context: `It cost ${(item.loss_cp / 100).toFixed(1)} pawns in your game on ${formatGameDate(item.played_at)}.`,
    }),
    score: (answer: ThreatAnswer, played: string): Scored => ({
      ...answer,
      answer_uci: answer.reply_uci,
      lesson: threatLesson(answer, played),
    }),
    summary: threatSummary,
  },
  punish: {
    label: 'Their mistakes',
    emblem: 'swords',
    title: 'Punish it',
    intro:
      '10 blunders your opponents made that you gave back. Find the punishment. Misses come back tomorrow.',
    waiting: 'Play your move on the board.',
    found: 'found',
    get: '/api/training/punish',
    post: '/api/training/punish/answer',
    rewardTitle: (correct: boolean) => (correct ? 'Punished' : 'Punish it'),
    ask: (item: PunishQuestion): Asked => ({
      ...item,
      last_uci: item.their_move_uci,
      prompt: punishPrompt(item),
      // Past ten pawns (and every mate) a pawn count means nothing; say what it was.
      context:
        item.gift_cp >= 1000
          ? `It handed you a winning position in your game on ${formatGameDate(item.played_at)}.`
          : `It was worth ${(item.gift_cp / 100).toFixed(1)} pawns in your game on ${formatGameDate(item.played_at)}.`,
    }),
    score: (answer: PunishAnswer, played: string): Scored => ({
      ...answer,
      lesson: punishLesson(answer, played),
    }),
    summary: punishSummary,
  },
} as const

/**
 * Blunder Check: the scan behind most lost points, from both sides.
 *
 * "Your mistakes" shows the position right after one of the player's own big
 * mistakes, opponent to move, and asks for the punishment: finding it is the
 * scan that would have stopped the move. "Their mistakes" (Punish it) shows
 * the position right after an opponent's big mistake the player handed
 * straight back, player to move, and asks for the move that keeps it — the
 * largest habit measured (38.7% of opponents' mistakes given back). Either
 * way the player's side is at the bottom and each answer is scored on the
 * server.
 */
export function BlunderCheck({ username, onBegin }: { username: string; onBegin?: () => void }) {
  const profile = useTrainingProfile(username).data
  const applyReward = useApplyReward(username)
  const loadPosition = useAppStore((state) => state.loadPosition)
  const alignBoardToUserColor = useAppStore((state) => state.alignBoardToUserColor)
  const setDrillSolving = useAppStore((state) => state.setDrillSolving)
  const setTrainerArrows = useAppStore((state) => state.setTrainerArrows)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const session = useTrainingStore((state) => state.session)
  const endSession = useTrainingStore((state) => state.endSession)

  const [mode, setMode] = useState<BlunderMode>(readMode)
  const [phase, setPhase] = useState<Phase>('idle')
  const [questions, setQuestions] = useState<Asked[]>([])
  const [index, setIndex] = useState(0)
  const [spotted, setSpotted] = useState(0)
  // One entry per position answered, in order: the result rank on the summary.
  const [results, setResults] = useState<boolean[]>([])
  const [lesson, setLesson] = useState<{ correct: boolean; text: string } | null>(null)
  const rootId = useRef<string | null>(null)
  const runId = useRef('')
  // The side the running set was started on; switching mid-set is not offered.
  const runMode = useRef<BlunderMode>(mode)

  const config = MODES[runMode.current]
  const question = questions[index]
  // The answer stays on the server, so the hint does too: the page asks for
  // its kind, then the piece, and never learns the move before playing one.
  const hints = useHint(
    phase === 'asking' && question
      ? {
          fen: fullFen(question.fen),
          fetch: (level) =>
            api
              .get<Hint>(`${MODES[runMode.current].get}/hint`, {
                params: { username, position_id: question.position_id, level },
              })
              .then((response) => response.data),
        }
      : null,
    question ? `${runId.current}:${question.position_id}` : null,
  )
  const hintLevel = useRef(0)
  hintLevel.current = hints.level

  function chooseMode(next: BlunderMode) {
    setMode(next)
    writeMode(next)
    setPhase('idle')
  }

  function ask(list: Asked[], at: number) {
    const item = list[at]
    if (!item) {
      setPhase('done')
      setDrillSolving(false)
      setTrainerArrows([])
      return
    }
    loadPosition(fullFen(item.fen), item.last_uci)
    // The player's own side at the bottom: this is their game, seen from their chair.
    alignBoardToUserColor(item.player_color)
    rootId.current = useAppStore.getState().currentNodeId
    setTrainerArrows([])
    setLesson(null)
    setIndex(at)
    setPhase('asking')
  }

  async function start() {
    endSession()
    onBegin?.()
    runMode.current = mode
    const chosen = MODES[mode]
    setPhase('loading')
    try {
      const response = await api.get<{ questions: (ThreatQuestion & PunishQuestion)[] }>(
        chosen.get,
        { params: { username, seed: Math.floor(Math.random() * 1_000_000) } },
      )
      if (!response.data.questions.length) {
        setPhase('empty')
        return
      }
      const list = response.data.questions.map((item) => chosen.ask(item))
      runId.current = `${Date.now()}`
      setQuestions(list)
      setSpotted(0)
      setResults([])
      setDrillSolving(true)
      ask(list, 0)
    } catch {
      setPhase('error')
    }
  }

  // A course session taking the board ends the set.
  useEffect(() => {
    if (session && (phase === 'asking' || phase === 'answered')) {
      setPhase('idle')
      setDrillSolving(false)
      setTrainerArrows([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new session matters
  }, [session])

  useEffect(
    () => () => {
      setDrillSolving(false)
      setTrainerArrows([])
    },
    [setDrillSolving, setTrainerArrows],
  )

  // The answer: the first move made from the position.
  useEffect(() => {
    if (phase !== 'asking' || !question) return
    const node = useAppStore.getState().nodes[currentNodeId]
    if (!node?.uci || node.parentId !== rootId.current) return
    const played = node.san ?? node.uci
    const running = MODES[runMode.current]
    setPhase('answered')
    void api
      .post<ThreatAnswer & PunishAnswer>(running.post, {
        username,
        position_id: question.position_id,
        played_uci: node.uci,
        hinted: hintLevel.current,
        request_id: `${runId.current}:${question.position_id}`,
        tz: browserTimeZone(),
        goal: readDailyGoal(),
      })
      .then((response) => {
        const answer = running.score(response.data, played)
        setResults((list) => [...list, answer.correct])
        if (answer.correct) setSpotted((value) => value + 1)
        else {
          if (rootId.current) useAppStore.getState().jumpToNode(rootId.current)
          // Scoped to the question's position: exploring the continuation
          // moves the board, and the arrow must not point at those squares.
          setTrainerArrows(
            [
              {
                startSquare: answer.answer_uci.slice(0, 2),
                endSquare: answer.answer_uci.slice(2, 4),
                color: 'rgba(214, 60, 45, 0.85)',
              },
            ],
            fullFen(question.fen),
          )
        }
        play(answer.correct ? 'right' : 'wrong')
        setLesson({ correct: answer.correct, text: answer.lesson })
        void applyReward(answer, running.rewardTitle(answer.correct))
      })
      .catch(() =>
        setLesson({ correct: false, text: "Couldn't score that answer. Go on to the next one." }),
      )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new move is an answer
  }, [currentNodeId])

  if (phase === 'asking' || phase === 'answered') {
    return (
      <section aria-label={config.title} className="blunder-check blunder-check--running">
        <div className="blunder-check__meta">
          <span>
            <Emblem name={config.emblem} size={18} /> {(index + 1).toLocaleString()} of{' '}
            {questions.length.toLocaleString()}
          </span>
          {question?.again ? <span className="blunder-check__again">Missed last time</span> : null}
          <span className="muted">
            {spotted.toLocaleString()} {config.found}
          </span>
        </div>
        {/* The set as a rank: a pawn on each one found, the current square outlined. */}
        <ol aria-hidden="true" className="result-rank result-rank--live">
          {questions.map((item, at) => (
            <li
              data-current={at === index || undefined}
              data-missed={results[at] === false || undefined}
              data-shade={at % 2 ? 'dark' : 'light'}
              key={item.position_id}
            >
              {results[at] ? <TitlePiece title="Pawn" /> : null}
            </li>
          ))}
        </ol>
        {question ? <p className="blunder-check__prompt">{question.prompt}</p> : null}
        {question ? (
          // Where this position comes from: safe to show while asking, since
          // the game and the cost say how much it mattered, not which move.
          <p className="muted blunder-check__context">
            {question.context}
            {question.game_url ? (
              <>
                {' '}
                <a href={question.game_url} rel="noreferrer" target="_blank">
                  See the game
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        {question && !lesson && phase === 'asking' ? <HintControl hints={hints} /> : null}
        <p
          aria-live="polite"
          className="blunder-check__lesson"
          data-correct={lesson ? lesson.correct : undefined}
        >
          {lesson?.text ?? (phase === 'answered' ? 'Checking…' : config.waiting)}
        </p>
        {/* Once the answer is resolved, the engine says how the line plays
            out — the same "what follows" line a finished drill gets.
            Clicking a ply only explores: the answer effect requires the
            asking phase and a child of the question's root. */}
        {question && lesson ? <DrillContinuation active fen={fullFen(question.fen)} /> : null}
        {lesson ? (
          <Button onClick={() => ask(questions, index + 1)} type="button" variant="primary">
            {index + 1 < questions.length ? (
              <>
                Next position <ArrowRight size={14} />
              </>
            ) : (
              'See how you did'
            )}
          </Button>
        ) : null}
      </section>
    )
  }

  if (phase === 'done') {
    return (
      <section aria-label={`${config.title} result`} className="blunder-check">
        <div className="result-hero">
          <Medal
            earned={questions.length > 0 && spotted === questions.length}
            emblem={config.emblem}
            label={`${spotted} of ${questions.length} ${config.found}`}
            progress={questions.length ? spotted / questions.length : 0}
            size={72}
          />
          <div className="result-hero__text">
            <span className="result-hero__score">
              {spotted}
              <span className="muted"> / {questions.length}</span>
            </span>
            <span className="muted">{config.summary(spotted, questions.length)}</span>
          </div>
        </div>
        {/* Each position a square: a pawn where the move was found. */}
        <ol aria-label="Positions" className="result-rank">
          {results.map((found, at) => (
            <li data-found={found || undefined} data-shade={at % 2 ? 'dark' : 'light'} key={at}>
              {found ? <TitlePiece title="Pawn" /> : null}
              <span className="sr-only-inline">
                Position {at + 1}: {found ? config.found : 'missed'}
              </span>
            </li>
          ))}
        </ol>
        <Button onClick={() => void start()} type="button" variant="primary">
          <RotateCcw size={14} /> Another {questions.length}
        </Button>
        <Button onClick={() => setPhase('idle')} type="button" variant="ghost">
          Back
        </Button>
      </section>
    )
  }

  const chosen = MODES[mode]
  const threatsSpotted = profile?.threats_spotted ?? 0
  const punishFound = profile?.punish_found ?? 0
  const seen = mode === 'threats' ? (profile?.threats_seen ?? 0) : (profile?.punish_seen ?? 0)
  const found = mode === 'threats' ? threatsSpotted : punishFound
  return (
    <section aria-label="Blunder Check" className="blunder-check">
      <div aria-label="Whose mistakes" className="workspace-tabs__list" role="group">
        {(['threats', 'punish'] as const).map((item) => (
          <button
            aria-pressed={mode === item}
            className={`workspace-tabs__button${mode === item ? ' workspace-tabs__button--active' : ''}`}
            key={item}
            onClick={() => chooseMode(item)}
            type="button"
          >
            {MODES[item].label}
          </button>
        ))}
      </div>
      <div className="rush__intro">
        {mode === 'threats' ? (
          // The arc is the way to Hawk eye: 50 punishments spotted.
          <Medal
            earned={threatsSpotted >= 50}
            emblem="eye"
            label={`${threatsSpotted} of 50 spotted toward Hawk eye`}
            progress={Math.min(1, threatsSpotted / 50)}
            size={48}
          />
        ) : (
          <Medal
            earned={false}
            emblem="swords"
            label={`${punishFound} found`}
            progress={seen ? punishFound / seen : 0}
            size={48}
          />
        )}
        <div>
          <strong>{chosen.title}</strong>
          <span className="muted">
            {chosen.intro}{' '}
            {seen
              ? `${found.toLocaleString()} of ${seen.toLocaleString()} ${chosen.found} so far.`
              : ''}
          </span>
        </div>
        <Button
          disabled={phase === 'loading'}
          onClick={() => void start()}
          type="button"
          variant="primary"
        >
          {phase === 'loading' ? 'Loading…' : `Start ${chosen.title}`}
        </Button>
      </div>
      {phase === 'empty' ? (
        <p className="muted rush__note">No positions yet. Review a few games first.</p>
      ) : phase === 'error' ? (
        <p className="muted rush__note" role="alert">
          Couldn't load your positions. Check your connection and press Start again.
        </p>
      ) : null}
    </section>
  )
}
