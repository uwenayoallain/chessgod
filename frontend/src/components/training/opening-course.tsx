import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Chess } from 'chess.js'
import { ArrowLeft, BookOpen, Crown, Cpu, Dumbbell, Play, RotateCcw } from 'lucide-react'

import { LineTrainer } from '@/components/training/line-trainer'
import { Medal, TitlePiece } from '@/components/training/trophies'
import type { EmblemName } from '@/lib/training/emblem-art'
import { Button } from '@/components/ui/button'
import { PanelError } from '@/components/ui/panel-error'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { repertoireQueryKey, useRepertoire } from '@/hooks/use-training'
import { api } from '@/lib/api'
import { scoreToWhitePerspective } from '@/lib/stockfish/eval'
import {
  buildChapters,
  dueLines,
  lineStakes,
  lineStatusLabel,
  lineTitle,
  nextCourseStep,
} from '@/lib/training/course'
import type { LineReviewResponse, Repertoire, RepertoireLine } from '@/lib/training/types'
import { useEngineStore } from '@/store/engine-store'
import { useTrainingStore } from '@/store/training-store'

const COLOR_KEY = 'chessgod.courseColor'
// Deep enough to rank four candidates reliably, quick enough to watch.
const CHECK_DEPTH = 18

function readColor(): 'white' | 'black' {
  try {
    return window.localStorage.getItem(COLOR_KEY) === 'white' ? 'white' : 'black'
  } catch {
    return 'black'
  }
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <span
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(value * 100)}
      className="course-bar"
      role="progressbar"
    >
      <span style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </span>
  )
}

/**
 * The engine's comparison of each repertoire position, run in this browser.
 * A position the engine has not searched with several lines can only offer
 * its single best move, so the repertoire marks it unchecked until this runs.
 */
function EngineCheck({ repertoire, username }: { repertoire: Repertoire; username: string }) {
  const queryClient = useQueryClient()
  const playMove = useEngineStore((state) => state.playMove)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const total = repertoire.needs_engine.length
  if (!total && !progress) return null

  async function run() {
    setError(null)
    let round = repertoire
    let done
    try {
      // A changed move can lead into positions nobody searched yet: go round again.
      for (let pass = 0; pass < 3 && round.needs_engine.length; pass += 1) {
        const work = round.needs_engine
        done = 0
        setProgress({ done, total: work.length })
        let batch: unknown[] = []
        for (const fen of work) {
          const full = `${fen} 0 1`
          const lines = await playMove(full, { depth: CHECK_DEPTH, multiPV: round.multipv })
          for (const line of lines ?? []) {
            if (!line.pv.length) continue
            const score = scoreToWhitePerspective(line.score, full)
            batch.push({
              fen,
              depth: line.depth,
              eval_cp: score.type === 'cp' ? score.value : null,
              eval_mate: score.type === 'mate' ? score.value : null,
              best_move_uci: line.pv[0],
              pv_uci: line.pv.join(' '),
              multipv_rank: line.multipv,
            })
          }
          done += 1
          setProgress({ done, total: work.length })
          if (batch.length >= 40) {
            await api.post('/api/analysis/evaluations', { items: batch })
            batch = []
          }
        }
        if (batch.length) await api.post('/api/analysis/evaluations', { items: batch })
        round = (
          await api.get<Repertoire>('/api/training/repertoire', {
            params: { username, color: repertoire.color, fresh: true },
          })
        ).data
        queryClient.setQueryData(repertoireQueryKey(username, repertoire.color), round)
      }
      setProgress(null)
    } catch {
      setError('The engine check stopped. What it finished is saved, so run it again to carry on.')
      setProgress(null)
    }
  }

  return (
    <div className="course-engine">
      <Cpu aria-hidden="true" size={15} />
      <div>
        {progress ? (
          <>
            <strong>
              Engine checking {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
            </strong>
            <ProgressBar
              label="Engine check"
              value={progress.total ? progress.done / progress.total : 0}
            />
          </>
        ) : (
          <>
            <strong>
              The engine hasn't checked {total.toLocaleString()}{' '}
              {total === 1 ? 'position' : 'positions'} yet.
            </strong>
            <span className="muted">
              Until it does, your moves there aren't compared with the alternatives.
            </span>
          </>
        )}
        {error ? <span className="course-engine__error">{error}</span> : null}
      </div>
      {!progress ? (
        <Button onClick={() => void run()} type="button" variant="default">
          Check now
        </Button>
      ) : null}
    </div>
  )
}

function LineMoves({ line }: { line: RepertoireLine }) {
  // The whole line, so two lessons that part late do not read as the same one,
  // with the move to change marked where it happens.
  return (
    <span className="course-line__moves">
      {line.moves.map((step, index) => {
        const number =
          step.ply % 2 === 1
            ? `${Math.ceil(step.ply / 2)}.`
            : index === 0
              ? `${Math.ceil(step.ply / 2)}…`
              : ''
        if (step.side === 'you' && step.status === 'change') {
          return (
            <span key={step.ply}>
              {number}
              <s>{step.usual_san}</s> <b>{step.san}</b>{' '}
            </span>
          )
        }
        return (
          <span
            data-trap={step.side === 'opponent' && step.trap_cp ? true : undefined}
            key={step.ply}
          >
            {number}
            {step.san}{' '}
          </span>
        )
      })}
    </span>
  )
}

/**
 * Where a boss fight starts: the line's last position with the player to move.
 *
 * A game played out takes the side to move as the player's, and most lines
 * end on the player's own move — starting after it would hand the player the
 * opponent's pieces. So the fight starts before the player's last move: they
 * play it themselves, then carry on alone.
 */
export function lineEnd(line: RepertoireLine): { fen: string; lastUci: string | null } | null {
  const last = line.moves[line.moves.length - 1]
  if (!last) return null
  if (last.side === 'you') {
    const before = line.moves[line.moves.length - 2]
    return { fen: `${last.fen} 0 1`, lastUci: before?.uci ?? null }
  }
  try {
    const board = new Chess(`${last.fen} 0 1`)
    board.move({
      from: last.uci.slice(0, 2),
      to: last.uci.slice(2, 4),
      promotion: last.uci.slice(4) || undefined,
    })
    return { fen: board.fen(), lastUci: last.uci }
  } catch {
    return null
  }
}

function LineRow({
  line,
  onStart,
  onBoss,
}: {
  line: RepertoireLine
  onStart: (mode: 'learn' | 'practice') => void
  onBoss?: () => void
}) {
  const label = lineStatusLabel(line)
  // What the line is for says which emblem it wears: a fix, a trap, or a line to keep.
  const emblem: EmblemName = line.changes > 0 ? 'shield' : line.traps > 0 ? 'crosshair' : 'book'
  const learned = line.your_moves ? line.known_moves / line.your_moves : 0
  return (
    <li className="course-line" data-status={line.status}>
      <Medal
        earned={line.status === 'mastered'}
        emblem={emblem}
        label={`${label}: ${line.known_moves} of ${line.your_moves} moves learned`}
        progress={learned}
        size={46}
      />
      <div className="course-line__main">
        <span className="course-line__status" data-status={line.status}>
          {label}
        </span>
        <strong className="course-line__title" title={lineTitle(line)}>
          {lineTitle(line)}
        </strong>
        <LineMoves line={line} />
        <span className="muted course-line__stakes">{lineStakes(line)}</span>
      </div>
      <div className="course-line__actions">
        {line.status === 'new' ? (
          <Button
            aria-label={`Learn ${lineTitle(line)}`}
            onClick={() => onStart('learn')}
            type="button"
            variant="primary"
          >
            <BookOpen size={13} /> Learn
          </Button>
        ) : (
          <Button
            aria-label={`Practice ${lineTitle(line)}`}
            onClick={() => onStart('practice')}
            type="button"
            variant={line.status === 'due' || !line.practised ? 'primary' : 'default'}
          >
            <Dumbbell size={13} /> Practice
          </Button>
        )}
        {line.status !== 'new' && onBoss ? (
          <Button
            aria-label={`Boss fight: play the engine from the end of ${lineTitle(line)}`}
            onClick={onBoss}
            title="Play the engine from the end of this line. Win or draw for 30 XP."
            type="button"
            variant="ghost"
          >
            <Crown size={13} /> Boss fight
          </Button>
        ) : null}
      </div>
    </li>
  )
}

export function OpeningCourse({
  username,
  onBegin,
  onPlayOut,
}: {
  username: string
  onBegin?: () => void
  /** Plays a position out against the engine; how a boss fight starts. */
  onPlayOut?: (position: { fen: string; lastUci: string | null; origin?: string }) => void
}) {
  const [chosenColor, setColorState] = useState<'white' | 'black'>(readColor)
  const session = useTrainingStore((state) => state.session)
  const courseColor = useTrainingStore((state) => state.courseColor)
  useEffect(() => {
    if (courseColor) setColorState(courseColor)
  }, [courseColor])
  // A session started elsewhere (the Today card) brings its own colour.
  const color = session?.color ?? chosenColor
  const repertoire = useRepertoire(username, color)
  const queryClient = useQueryClient()
  const startSession = useTrainingStore((state) => state.startSession)
  const advanceSession = useTrainingStore((state) => state.advanceSession)
  const switchMode = useTrainingStore((state) => state.switchMode)
  const endSession = useTrainingStore((state) => state.endSession)
  const [finished, setFinished] = useState<{
    key: string
    result: LineReviewResponse | null
  } | null>(null)
  const [attempt, setAttempt] = useState(0)

  function setColor(next: 'white' | 'black') {
    setColorState(next)
    try {
      window.localStorage.setItem(COLOR_KEY, next)
    } catch {
      // The choice lasts for this visit.
    }
  }

  const data = repertoire.data

  if (repertoire.isLoading && !session) {
    return <PanelSkeleton label="Building your repertoire" rows={5} rowHeight={56} />
  }
  if (repertoire.error || !data) {
    return (
      <PanelError
        error={repertoire.error}
        onRetry={() => void repertoire.refetch()}
        what="your repertoire"
      />
    )
  }

  const lines = data.lines
  const byId = new Map(lines.map((line) => [line.id, line]))

  if (session) {
    const line = byId.get(session.lineIds[session.index])
    if (!line) {
      return (
        <div className="course">
          <p className="muted">That line has changed since the session started.</p>
          <Button onClick={endSession} type="button" variant="default">
            Back to the course
          </Button>
        </div>
      )
    }
    const key = `${line.id}:${session.mode}:${attempt}`
    const done = finished?.key === key
    const more = session.index < session.lineIds.length - 1
    return (
      <div className="course course--session">
        <div className="course-session__bar">
          <button className="course-session__back" onClick={endSession} type="button">
            <ArrowLeft size={14} /> Course
          </button>
          {/* The trainer names the mode itself, so the bar only places you in the set. */}
          <span className="muted">
            {session.lineIds.length > 1
              ? `${(session.index + 1).toLocaleString()} of ${session.lineIds.length.toLocaleString()}`
              : ''}
          </span>
        </div>
        <LineTrainer
          color={session.color}
          key={key}
          line={line}
          mode={session.mode}
          onBegin={onBegin}
          onFinished={(result) => {
            setFinished({ key, result })
            // The line is no longer new, nothing in it is due, and a clean
            // practice pass has played it from memory: say so on every card
            // that reads the repertoire before the server confirms.
            queryClient.setQueryData<Repertoire>(
              repertoireQueryKey(username, session.color),
              (current) =>
                current && {
                  ...current,
                  lines: current.lines.map((item) =>
                    item.id === line.id
                      ? {
                          ...item,
                          status: item.status === 'new' ? 'learning' : item.status,
                          due_moves: 0,
                          practised:
                            item.practised || (session.mode === 'practice' && result?.misses === 0),
                        }
                      : item,
                  ),
                },
            )
            void queryClient.invalidateQueries({
              queryKey: repertoireQueryKey(username, session.color),
            })
          }}
          timeClass={data.time_class}
          username={username}
        />
        {done ? (
          <div className="course-session__next">
            {finished?.result == null ? (
              <p className="muted">Couldn't save this run, so your moves weren't scored.</p>
            ) : null}
            {more ? (
              <Button
                onClick={() => {
                  setFinished(null)
                  advanceSession()
                }}
                type="button"
                variant="primary"
              >
                <Play size={14} /> Next line
              </Button>
            ) : null}
            {session.mode === 'learn' ? (
              <Button
                onClick={() => {
                  setFinished(null)
                  switchMode('practice')
                }}
                type="button"
                variant={more ? 'default' : 'primary'}
              >
                <Dumbbell size={14} /> Practice it now
              </Button>
            ) : (
              <Button
                onClick={() => {
                  setFinished(null)
                  setAttempt((value) => value + 1)
                }}
                type="button"
                variant="default"
              >
                <RotateCcw size={14} /> Practice again
              </Button>
            )}
            <Button onClick={endSession} type="button" variant="ghost">
              Back to the course
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  const chapters = buildChapters(lines, color)
  const due = dueLines(lines)
  const next = nextCourseStep(lines, color)
  const totalMoves = lines.reduce((n, line) => n + line.your_moves, 0)
  const knownMoves = lines.reduce((n, line) => n + line.known_moves, 0)
  const fixes = lines.filter((line) => line.changes > 0).length

  function start(ids: string[], mode: 'learn' | 'practice', label: string) {
    setFinished(null)
    startSession({ color, lineIds: ids, mode, label })
  }

  return (
    <div className="course">
      <div aria-label="Repertoire color" className="course-tabs" role="group">
        {(['black', 'white'] as const).map((value) => (
          <button
            aria-pressed={color === value}
            className="course-tabs__tab"
            key={value}
            onClick={() => setColor(value)}
            type="button"
          >
            <TitlePiece side={value === 'black' ? 'b' : 'w'} title="King" />
            {value === 'black' ? 'As Black' : 'As White'}
          </button>
        ))}
      </div>

      <div className="course-summary">
        <Medal
          earned={totalMoves > 0 && knownMoves >= totalMoves}
          emblem="rook"
          label={`${knownMoves} of ${totalMoves} moves learned`}
          progress={totalMoves ? knownMoves / totalMoves : 0}
          size={64}
        />
        <p className="course-summary__headline">
          {fixes
            ? `${fixes.toLocaleString()} ${fixes === 1 ? 'line needs' : 'lines need'} a different move. You play the rest well.`
            : 'You already play every line here soundly. Keep them sharp.'}
        </p>
        <span className="muted course-summary__count">
          {knownMoves.toLocaleString()} of {totalMoves.toLocaleString()} moves learned across{' '}
          {lines.length.toLocaleString()} lines
        </span>
        <div className="course-summary__actions">
          {due.length ? (
            <Button
              onClick={() =>
                start(
                  due.map((line) => line.id),
                  'practice',
                  'Review',
                )
              }
              type="button"
              variant="primary"
            >
              <Dumbbell size={14} /> Review{' '}
              {due.reduce((n, line) => n + line.due_moves, 0).toLocaleString()} due
            </Button>
          ) : null}
          {next ? (
            <Button
              onClick={() =>
                start([next.line.id], next.mode, next.mode === 'learn' ? 'Learn' : 'Practice')
              }
              type="button"
              variant={due.length ? 'default' : 'primary'}
            >
              {next.mode === 'learn' ? <BookOpen size={14} /> : <Dumbbell size={14} />}{' '}
              {next.mode === 'learn' ? 'Learn next' : 'Practice next'}: {lineTitle(next.line)}
            </Button>
          ) : null}
        </div>
      </div>

      <EngineCheck repertoire={data} username={username} />

      {chapters.map((chapter) => (
        <section className="course-chapter" key={chapter.key}>
          <header className="course-chapter__head">
            <div>
              <h3>{chapter.title}</h3>
              <span className="muted">{chapter.subtitle}</span>
            </div>
            <span className="course-chapter__count">
              {chapter.knownMoves.toLocaleString()}/{chapter.yourMoves.toLocaleString()}
            </span>
          </header>
          <ProgressBar
            label={`${chapter.title}: ${chapter.knownMoves} of ${chapter.yourMoves} moves learned`}
            value={chapter.yourMoves ? chapter.knownMoves / chapter.yourMoves : 0}
          />
          <ul className="course-lines">
            {chapter.lines.map((line) => (
              <LineRow
                key={line.id}
                line={line}
                onBoss={
                  onPlayOut
                    ? () => {
                        const end = lineEnd(line)
                        if (end) onPlayOut({ ...end, origin: `boss:${line.id}` })
                      }
                    : undefined
                }
                onStart={(mode) => start([line.id], mode, mode === 'learn' ? 'Learn' : 'Practice')}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
