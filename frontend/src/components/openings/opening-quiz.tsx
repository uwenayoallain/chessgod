import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronRight, RotateCcw, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { HintControl } from '@/components/training/hint-control'
import { ExploreButton } from '@/components/ui/explore-button'
import { Medal } from '@/components/training/trophies'
import { useHint } from '@/hooks/use-hint'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelError } from '@/components/ui/panel-error'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { postTrainingEvent, useApplyReward } from '@/hooks/use-training'
import { api } from '@/lib/api'
import {
  describeUsualMove,
  formatShare,
  gradeQuizMove,
  type OpeningQuizPosition,
  type QuizVerdict,
} from '@/lib/openings/opening-quiz'
import { useAppStore } from '@/store/app-store'

type Status = 'idle' | 'asking' | 'answered' | 'done'

function useOpeningQuiz(username: string, color: string, timeClass: string | null) {
  return useQuery({
    queryKey: ['opening-quiz', username, color, timeClass],
    queryFn: async ({ signal }) =>
      (
        await api.get<OpeningQuizPosition[]>('/api/theory/opening-quiz', {
          params: { username, color, time_class: timeClass ?? undefined, limit: 12 },
          signal,
        })
      ).data,
    staleTime: 10 * 60 * 1000,
  })
}

/**
 * A quiz on the player's own openings: positions they reach with the move
 * theirs, asked against the master book. Positions where their usual move is
 * not book come first, since that is where the repertoire leaks.
 *
 * It borrows the drill trainer's mechanics — `loadPosition` roots the board at
 * the question, the first move played from that root is the answer, and
 * `drillSolving` hides book markers and engine arrows while it is open.
 */
export function OpeningQuiz({
  username,
  color,
  timeClass,
  onBegin,
}: {
  username: string
  color: 'white' | 'black' | 'both'
  timeClass: string | null
  onBegin?: () => void
}) {
  const quiz = useOpeningQuiz(username, color, timeClass)
  const [index, setIndex] = useState(0)
  const [status, setStatus] = useState<Status>('idle')
  const [answer, setAnswer] = useState<{ san: string; verdict: QuizVerdict } | null>(null)
  // The first answer per position: a retry is practice, not a second score.
  const [results, setResults] = useState<Record<number, QuizVerdict['kind']>>({})
  const rootId = useRef<string | null>(null)
  // One run of the quiz: its first answers earn XP once, however often it re-renders.
  const run = useRef(Date.now())
  const applyReward = useApplyReward(username)

  const loadPosition = useAppStore((state) => state.loadPosition)
  const alignBoardToUserColor = useAppStore((state) => state.alignBoardToUserColor)
  const setDrillSolving = useAppStore((state) => state.setDrillSolving)
  const currentNode = useAppStore((state) => state.nodes[state.currentNodeId])

  const positions = quiz.data ?? []
  const position = positions[index] as OpeningQuizPosition | undefined
  // Toward the book's main move; any book move still scores.
  const book = position?.book_moves[0]
  const hints = useHint(
    status === 'asking' && position && book ? { fen: position.fen, uci: book.uci } : null,
    position?.position_id ?? null,
  )

  function ask(next: number) {
    const item = positions[next]
    if (!item) return
    onBegin?.()
    loadPosition(item.fen, item.last_move_uci)
    alignBoardToUserColor(item.side_to_move)
    rootId.current = useAppStore.getState().currentNodeId
    setIndex(next)
    setAnswer(null)
    setStatus('asking')
  }

  function next() {
    if (index >= positions.length - 1) {
      setStatus('done')
      return
    }
    ask(index + 1)
  }

  function restart() {
    run.current = Date.now()
    setResults({})
    ask(0)
  }

  // The answer: the first move played from the question's root.
  useEffect(() => {
    if (status !== 'asking' || !position || !currentNode?.uci) return
    if (currentNode.parentId !== rootId.current) return
    const verdict = gradeQuizMove(position, currentNode.uci)
    setAnswer({ san: currentNode.san ?? currentNode.uci, verdict })
    setResults((previous) =>
      index in previous ? previous : { ...previous, [index]: verdict.kind },
    )
    if (!(index in results)) {
      const inBook = verdict.kind !== 'off-book'
      void postTrainingEvent(
        username,
        inBook ? 'quiz_correct' : 'quiz_answer',
        `quiz:${run.current}:${position.position_id}`,
        { position_id: position.position_id },
      ).then((reward) => applyReward(reward, inBook ? 'Book move' : 'Quiz answer'))
    }
    setStatus('answered')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scored once per new move
  }, [currentNode, index, position, status])

  useEffect(() => {
    setDrillSolving(status === 'asking')
  }, [setDrillSolving, status])
  useEffect(() => () => setDrillSolving(false), [setDrillSolving])

  if (quiz.isLoading) return <PanelSkeleton label="Finding your opening positions" rows={3} />
  if (quiz.error) {
    return (
      <PanelError error={quiz.error} onRetry={() => void quiz.refetch()} what="the opening quiz" />
    )
  }
  if (!positions.length) {
    return (
      <EmptyState
        title="No book positions yet"
        message="No positions masters play often yet. Import more games."
      />
    )
  }

  const answered = Object.values(results)
  const inBook = answered.filter((kind) => kind !== 'off-book').length

  if (status === 'idle' || status === 'done') {
    const leaks = positions.filter((item) => !item.usual_move_in_book).length
    return (
      <div className="opening-quiz">
        {status === 'done' ? (
          <div className="result-hero">
            <Medal
              earned={answered.length > 0 && inBook === answered.length}
              emblem="question"
              label={`${inBook} of ${answered.length} answers were book moves`}
              progress={answered.length ? inBook / answered.length : 0}
              size={64}
            />
            <div className="result-hero__text">
              <span className="result-hero__score">
                {inBook.toLocaleString()}
                <span className="muted"> / {answered.length.toLocaleString()}</span>
              </span>
              <span className="muted">answers were book moves.</span>
            </div>
          </div>
        ) : null}
        <p className="muted opening-quiz__intro">
          {positions.length.toLocaleString()} positions from your own games.{' '}
          {leaks > 0
            ? `In ${leaks.toLocaleString()} of them your usual move isn't a book move, so those come first.`
            : 'Your usual move is a book move in all of them.'}
        </p>
        <Button onClick={restart} type="button" variant="primary">
          {status === 'done' ? (
            <>
              <RotateCcw size={14} /> Go again
            </>
          ) : (
            'Start the quiz'
          )}
        </Button>
      </div>
    )
  }

  if (!position) return null
  const usual = describeUsualMove(position)

  return (
    <div className="opening-quiz">
      <div className="opening-quiz__meta">
        <span>
          Position {(index + 1).toLocaleString()} of {positions.length.toLocaleString()}
        </span>
        <span className="muted">
          {inBook.toLocaleString()} / {answered.length.toLocaleString()} in book
        </span>
      </div>
      <p className="opening-quiz__question">
        <strong>{position.opening_name ?? 'Your opening'}</strong>
        <span className="muted">
          {' '}
          · you reached this {position.occurrences.toLocaleString()}{' '}
          {position.occurrences === 1 ? 'time' : 'times'}
        </span>
      </p>

      {status === 'asking' ? (
        <p className="opening-quiz__prompt">
          {position.side_to_move === 'white' ? 'White' : 'Black'} to move. Play your move on the
          board.
        </p>
      ) : answer ? (
        <div className="opening-quiz__answer" data-kind={answer.verdict.kind} aria-live="polite">
          <p className="opening-quiz__verdict">
            {answer.verdict.kind === 'off-book' ? <X size={15} /> : <Check size={15} />}
            <span>
              <strong>{answer.san}.</strong> {answer.verdict.headline}
            </span>
          </p>
          <ul className="opening-quiz__book" aria-label="Master moves">
            {position.book_moves.slice(0, 4).map((move) => (
              <li key={move.uci}>
                <span className="opening-quiz__san">{move.san}</span>
                <span className="opening-quiz__bar">
                  <span style={{ width: formatShare(move.share) }} />
                </span>
                <span className="muted">{formatShare(move.share)}</span>
              </li>
            ))}
          </ul>
          {usual ? <p className="muted opening-quiz__usual">{usual}</p> : null}
        </div>
      ) : null}

      <div className="opening-quiz__actions">
        {status === 'answered' ? (
          <>
            <Button onClick={next} type="button" variant="primary">
              {index >= positions.length - 1 ? 'Finish' : 'Next position'}{' '}
              <ChevronRight size={14} />
            </Button>
            {answer?.verdict.kind === 'off-book' ? (
              // Only after a miss: offered after a book move it reads as one.
              <Button onClick={() => ask(index)} type="button">
                <RotateCcw size={14} /> Try again
              </Button>
            ) : null}
            <ExploreButton />
          </>
        ) : (
          <>
            <HintControl hints={hints} />
            <Button onClick={next} type="button" variant="ghost">
              Skip
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
