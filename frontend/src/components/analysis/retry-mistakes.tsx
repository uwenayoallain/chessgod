import { useEffect, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { ArrowRight, RotateCcw, X } from 'lucide-react'
import { create } from 'zustand'

import { Button } from '@/components/ui/button'
import { HintControl } from '@/components/training/hint-control'
import { Medal, TitlePiece } from '@/components/training/trophies'
import { useHint } from '@/hooks/use-hint'
import { play } from '@/lib/sound'
import { postTrainingEvent, useApplyReward } from '@/hooks/use-training'
import { PLAY_ARROW_COLOR } from '@/lib/analysis/board-guidance'
import { judgeRetry, scoreToCp, type RetryItem, type RetryVerdict } from '@/lib/analysis/retry'
import { uciToSan } from '@/lib/chess-utils'
import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'

// Deep enough to tell a fine move from a losing one, quick enough to feel instant.
const RETRY_DEPTH = 16
// A second wrong answer shows the move: a retry is practice, not a wall.
const TRIES = 2
const ANSWER_ARROW = PLAY_ARROW_COLOR

type RetrySession = {
  /** The game, so a retry pays once per mistake however often it is repeated. */
  gameKey: string
  items: RetryItem[]
  index: number
  /** Where the board was when the retry began, to go back to afterwards. */
  returnNodeId: string
  found: number
  /** One entry per mistake asked, in order: found a better move or not. */
  results: boolean[]
}

type RetryState = {
  session: RetrySession | null
  start: (session: Omit<RetrySession, 'index' | 'found' | 'results'>) => void
  next: (found: boolean) => void
  end: () => void
}

export const useRetryStore = create<RetryState>((set, get) => ({
  session: null,
  start: (session) => set({ session: { ...session, index: 0, found: 0, results: [] } }),
  next: (found) => {
    const session = get().session
    if (!session) return
    set({
      session: {
        ...session,
        index: session.index + 1,
        found: session.found + Number(found),
        results: [...session.results, found],
      },
    })
  },
  end: () => set({ session: null }),
}))

export function useIsRetrying() {
  return useRetryStore((state) => state.session != null)
}

type Attempt =
  | { status: 'asking'; tries: number; note?: string }
  | { status: 'checking'; tries: number }
  | { status: 'done'; tries: number; verdict: RetryVerdict; attemptSan: string | null }

function arrow(uci: string) {
  return [{ startSquare: uci.slice(0, 2), endSquare: uci.slice(2, 4), color: ANSWER_ARROW }]
}

function moveNumber(ply: number) {
  return `${Math.ceil(ply / 2)}${ply % 2 === 1 ? '.' : '…'}`
}

/** The player's side's view of a search: the side to move searched it. */
async function search(fen: string): Promise<{ cp: number; best: string | null } | null> {
  const board = new Chess(fen)
  if (board.isCheckmate()) return { cp: -2000, best: null }
  if (board.isDraw() || board.isStalemate()) return { cp: 0, best: null }
  const lines = await useEngineStore.getState().playMove(fen, { depth: RETRY_DEPTH, multiPV: 1 })
  const top = lines?.find((line) => line.multipv === 1) ?? lines?.[0]
  return top ? { cp: scoreToCp(top.score), best: top.pv[0] ?? null } : null
}

/**
 * Chess.com's "Retry": each of the player's mistakes in the game, oldest
 * first, from the position they played it in. Attempts branch off the game on
 * the board; a move the engine rates as good as its own counts, not only its
 * first choice. Engine output stays hidden while a position is being asked.
 */
export function RetryMistakes() {
  const session = useRetryStore((state) => state.session)
  const next = useRetryStore((state) => state.next)
  const end = useRetryStore((state) => state.end)
  const nodes = useAppStore((state) => state.nodes)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const jumpToNode = useAppStore((state) => state.jumpToNode)
  const setDrillSolving = useAppStore((state) => state.setDrillSolving)
  const setTrainerArrows = useAppStore((state) => state.setTrainerArrows)
  const username = useAppStore((state) => state.username)
  const applyReward = useApplyReward(username)
  const [attempt, setAttempt] = useState<Attempt>({ status: 'asking', tries: 0 })
  const before = useRef<Promise<{ cp: number; best: string | null } | null> | null>(null)
  const bestUci = useRef<string | null>(null)

  const item = session ? session.items[session.index] : undefined
  const hints = useHint(
    item && attempt.status === 'asking' && item.bestUci
      ? { fen: item.fenBefore, uci: item.bestUci }
      : null,
    item ? `${session?.gameKey}:${item.ply}` : null,
  )

  // A new position: go to it, hide the answer, and start the engine on it
  // while the player thinks.
  useEffect(() => {
    if (!item) return
    jumpToNode(item.parentNodeId)
    setDrillSolving(true)
    setTrainerArrows([])
    setAttempt({ status: 'asking', tries: 0 })
    bestUci.current = item.bestUci
    before.current = search(item.fenBefore).then((result) => {
      if (result?.best) bestUci.current = bestUci.current ?? result.best
      return result
    })
  }, [item, jumpToNode, setDrillSolving, setTrainerArrows])

  // Leaving the retry puts the board's hints back.
  useEffect(
    () => () => {
      useAppStore.getState().setDrillSolving(false)
      useAppStore.getState().setTrainerArrows([])
    },
    [],
  )

  function reward(found: boolean) {
    if (!username || !session || !item) return
    void postTrainingEvent(
      username,
      found ? 'retry_found' : 'retry_missed',
      `retry:${session.gameKey}:${item.ply}`,
    ).then((result) => applyReward(result, found ? 'Mistake fixed' : undefined))
  }

  function finish(verdict: RetryVerdict, attemptSan: string | null, tries: number) {
    setAttempt({ status: 'done', verdict, attemptSan, tries })
    play(verdict === 'worse' ? 'wrong' : 'right')
    setDrillSolving(false)
    const answer = bestUci.current
    if (answer) setTrainerArrows(arrow(answer))
    reward(verdict === 'best' || verdict === 'good')
  }

  // An attempt is a move played from the asked position.
  useEffect(() => {
    if (!item || attempt.status !== 'asking') return
    const node = nodes[currentNodeId]
    if (!node || node.parentId !== item.parentNodeId || !node.uci) return
    const tries = attempt.tries
    const played = node.uci
    const san = node.san
    let cancelled = false
    async function judge() {
      const quick = judgeRetry({ attemptUci: played, gameUci: item!.uci, bestUci: item!.bestUci })
      if (quick === 'same') {
        setAttempt({
          status: 'asking',
          tries,
          note: `${item!.san} is what you played in the game. Find something better.`,
        })
        window.setTimeout(() => jumpToNode(item!.parentNodeId), 700)
        return
      }
      if (quick === 'best') {
        finish('best', san, tries)
        return
      }
      setAttempt({ status: 'checking', tries })
      const [start, after] = [await before.current, await search(node!.fen)]
      if (cancelled) return
      const verdict = judgeRetry({
        attemptUci: played,
        gameUci: item!.uci,
        bestUci: bestUci.current,
        bestCp: start?.cp,
        // The search after the attempt is from the opponent's side.
        attemptCp: after ? -after.cp : null,
      })
      if (verdict === 'best' || verdict === 'good') {
        finish(verdict, san, tries)
      } else if (tries + 1 < TRIES) {
        setAttempt({
          status: 'asking',
          tries: tries + 1,
          note: `${san ?? 'That'} doesn't hold either. One more try.`,
        })
        window.setTimeout(() => jumpToNode(item!.parentNodeId), 900)
      } else {
        finish('worse', san, tries + 1)
      }
    }
    void judge()
    return () => {
      cancelled = true
    }
    // Judged once per move played; the rest is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNodeId, item])

  if (!session) return null

  function close() {
    const returnTo = session!.returnNodeId
    end()
    setDrillSolving(false)
    setTrainerArrows([])
    jumpToNode(returnTo)
  }

  if (!item) {
    return (
      <div className="retry" data-state="summary">
        <div className="result-hero">
          <Medal
            earned={session.found === session.items.length}
            emblem="retry"
            label={`${session.found} of ${session.items.length} mistakes fixed`}
            progress={session.items.length ? session.found / session.items.length : 0}
            size={64}
          />
          <div className="result-hero__text">
            <span className="result-hero__score">
              {session.found.toLocaleString()}
              <span className="muted"> / {session.items.length.toLocaleString()}</span>
            </span>
            <span className="muted">
              {session.found === session.items.length
                ? 'You found a better move every time.'
                : 'Retry again later to catch the ones that got away.'}
            </span>
          </div>
        </div>
        <ol aria-label="Mistakes" className="result-rank">
          {session.results.map((found, at) => (
            <li data-shade={at % 2 ? 'dark' : 'light'} key={at}>
              {found ? <TitlePiece title="Pawn" /> : null}
              <span className="sr-only-inline">
                Mistake {at + 1}: {found ? 'fixed' : 'missed'}
              </span>
            </li>
          ))}
        </ol>
        <Button onClick={close} type="button" variant="primary">
          Back to the game
        </Button>
      </div>
    )
  }

  const answerSan = bestUci.current ? uciToSan(item.fenBefore, bestUci.current) : null
  const done = attempt.status === 'done' ? attempt : null
  return (
    <div
      className="retry"
      data-state={done ? (done.verdict === 'worse' ? 'missed' : 'found') : 'asking'}
    >
      <div className="retry__head">
        <span className="muted">
          Mistake {(session.index + 1).toLocaleString()} of {session.items.length.toLocaleString()}
        </span>
        <button aria-label="Stop retrying" className="retry__close" onClick={close} type="button">
          <X size={14} />
        </button>
      </div>
      {done ? (
        <>
          <p className="retry__title" role="status">
            {done.verdict === 'best'
              ? `${done.attemptSan}, the engine's move.`
              : done.verdict === 'good'
                ? `${done.attemptSan} works too.`
                : `The move was ${answerSan ?? 'the one on the arrow'}.`}
          </p>
          <p className="muted retry__text" aria-live="polite">
            {done.verdict === 'good' && answerSan
              ? `The engine preferred ${answerSan}, but yours holds the position too. `
              : ''}
            In the game you played {moveNumber(item.ply)} {item.san}.
          </p>
          <Button onClick={() => next(done.verdict !== 'worse')} type="button" variant="primary">
            {session.index + 1 < session.items.length ? 'Next mistake' : 'Finish'}{' '}
            <ArrowRight size={14} />
          </Button>
        </>
      ) : (
        <>
          <p className="retry__title">
            You played {moveNumber(item.ply)} {item.san} here ({item.label.toLowerCase()}). Find a
            better move.
          </p>
          <p className="muted retry__text" aria-live="polite">
            {attempt.status === 'checking'
              ? 'Checking your move…'
              : attempt.status === 'asking' && attempt.note
                ? attempt.note
                : 'Look at checks, captures and threats first, for both sides.'}
          </p>
          <div className="line-trainer__help">
            <HintControl disabled={attempt.status !== 'asking'} hints={hints} />
            <Button
              onClick={() => finish('worse', null, attempt.tries)}
              type="button"
              variant="ghost"
            >
              <RotateCcw size={14} /> Show me
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
