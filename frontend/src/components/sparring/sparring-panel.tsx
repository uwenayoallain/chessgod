import { useEffect, useState } from 'react'
import { Flag, Minus, Plus, RotateCcw, Swords, Undo2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  useOpenSparringGame,
  useSparringHistory,
  useStartSparring,
  type SparringHistory,
} from '@/hooks/use-sparring'
import { formatGameDate } from '@/lib/format-date'
import {
  clampSparRating,
  describeOutcome,
  describeReviewStatus,
  formatClock,
  sideToMove,
  SPAR_ELO_STEP,
  SPAR_TIME_CONTROLS,
  type SparColor,
} from '@/lib/sparring/sparring'
import { STARTING_FEN, useAppStore, type MoveNode } from '@/store/app-store'
import { clockRemaining, readSparStrength, useSparStore } from '@/store/spar-store'

function positionKey(fen: string) {
  return fen.trim().split(/\s+/).slice(0, 4).join(' ')
}

/**
 * Play against Stockfish at roughly the player's own strength.
 *
 * The opponent starts at the player's current rating, choosing moves the way
 * `chooseSparMove` does, and moves toward an even match with every rated game.
 */
export function SparringPanel({
  onBeforeNewGame,
  username,
}: {
  onBeforeNewGame: () => void
  username: string
}) {
  const status = useSparStore((state) => state.status)
  const userColor = useSparStore((state) => state.userColor)
  const gameElo = useSparStore((state) => state.elo)
  const rated = useSparStore((state) => state.rated)
  const outcome = useSparStore((state) => state.outcome)
  const eloChange = useSparStore((state) => state.eloChange)
  const finish = useSparStore((state) => state.finish)
  const markUnrated = useSparStore((state) => state.markUnrated)
  const close = useSparStore((state) => state.close)

  const currentFen = useAppStore((state) => state.currentFen)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const nodes = useAppStore((state) => state.nodes)
  const timeControl = useSparStore((state) => state.timeControlSeconds)
  const setTimeControl = useSparStore((state) => state.setTimeControl)
  const savedGameId = useSparStore((state) => state.savedGameId)
  const mistakesPosted = useSparStore((state) => state.mistakesPosted)
  const reviewSettled = useSparStore((state) => state.reviewSettled)
  const openSavedGame = useOpenSparringGame(onBeforeNewGame)
  const { data: history } = useSparringHistory(username)
  const setOverride = useSparStore((state) => state.setOverride)

  const stored = readSparStrength(username)
  const {
    calibratedElo,
    offeredElo,
    override,
    rapidRating: rapid,
    startGame,
    playOut,
  } = useStartSparring(username, onBeforeNewGame)

  // Temporary by design: a hand-picked strength is never saved.
  function adjust(delta: number) {
    const next = clampSparRating(offeredElo + delta)
    setOverride(next === calibratedElo ? null : next)
  }

  function resign() {
    const app = useAppStore.getState()
    let node: MoveNode | undefined = app.nodes[app.currentNodeId]
    let playerMoved = false
    while (node?.parentId) {
      const parent: MoveNode | undefined = app.nodes[node.parentId]
      if (parent && sideToMove(parent.fen) === userColor) playerMoved = true
      node = parent
    }
    // A game abandoned before the player moved says nothing about their play.
    if (!playerMoved) {
      close()
      return
    }
    finish({ result: 'loss', reason: 'resignation' }, username)
  }

  function newGame(color: SparColor) {
    startGame(color)
  }

  function playFromHere() {
    const app = useAppStore.getState()
    playOut({ fen: app.currentFen, lastUci: app.nodes[app.currentNodeId]?.uci ?? null })
  }

  function takeBack() {
    const app = useAppStore.getState()
    let node: MoveNode | undefined = app.nodes[app.currentNodeId]
    // Step back at least one ply, to the last position where it was the
    // player's turn.
    do {
      node = node?.parentId ? app.nodes[node.parentId] : undefined
    } while (node && sideToMove(node.fen) !== userColor)
    if (!node) return
    markUnrated()
    app.jumpToNode(node.id)
  }

  if (status === 'idle') {
    const atStart = positionKey(currentFen) === positionKey(STARTING_FEN)
    return (
      <div className="sparring">
        <div className="sparring__strength">
          <Button
            aria-label="Weaker opponent"
            onClick={() => adjust(-SPAR_ELO_STEP)}
            type="button"
            variant="ghost"
          >
            <Minus size={14} />
          </Button>
          <div className="sparring__elo">
            <strong className="mono">{offeredElo.toLocaleString()}</strong>
            <span className="muted">
              {override != null ? (
                <>
                  set by you, for now ·{' '}
                  <button
                    className="sparring__reset"
                    onClick={() => setOverride(null)}
                    type="button"
                  >
                    reset
                  </button>
                </>
              ) : stored ? (
                `after ${stored.games.toLocaleString()} ${stored.games === 1 ? 'game' : 'games'}`
              ) : rapid ? (
                `matched to your ${rapid.toLocaleString()} rapid play`
              ) : (
                'starting strength'
              )}
            </span>
          </div>
          <Button
            aria-label="Stronger opponent"
            onClick={() => adjust(SPAR_ELO_STEP)}
            type="button"
            variant="ghost"
          >
            <Plus size={14} />
          </Button>
        </div>
        <div className="sparring__actions">
          <Button onClick={() => newGame('white')} type="button" variant="primary">
            <Swords size={14} /> Play as White
          </Button>
          <Button onClick={() => newGame('black')} type="button">
            <Swords size={14} /> Play as Black
          </Button>
        </div>
        <div className="sparring__clock-choice" role="group" aria-label="Clock">
          {SPAR_TIME_CONTROLS.map((seconds) => (
            <button
              aria-pressed={timeControl === seconds}
              className="sparring__clock-option"
              key={seconds ?? 'none'}
              onClick={() => setTimeControl(seconds)}
              type="button"
            >
              {seconds == null ? 'No clock' : `${seconds / 60} min`}
            </button>
          ))}
        </div>
        {!atStart ? (
          <Button className="sparring__from-here" onClick={playFromHere} type="button">
            Play this position out ({sideToMove(currentFen) === 'white' ? 'White' : 'Black'} to
            move)
          </Button>
        ) : null}
        <p className="sparring__note muted">
          It misses tactics the way people do. Win and it gets {SPAR_ELO_STEP} points stronger; lose
          and it drops {SPAR_ELO_STEP}. Finished games are reviewed and drilled.
          {override != null ? ' At a hand-picked strength, games are unrated.' : ''}
        </p>
        {history && history.summary.played > 0 ? (
          <SparringRecord history={history} onOpen={openSavedGame} />
        ) : null}
      </div>
    )
  }

  const isLeaf = (nodes[currentNodeId]?.children.length ?? 0) === 0
  const yourTurn = sideToMove(currentFen) === userColor

  if (status === 'playing') {
    return (
      <div className="sparring">
        <div className="sparring__status" aria-live="polite">
          <strong>
            {!isLeaf
              ? 'Looking back through the game'
              : yourTurn
                ? 'Your move'
                : 'Stockfish is thinking…'}
          </strong>
          <span className="muted">
            You have {userColor === 'white' ? 'White' : 'Black'} · opponent around{' '}
            {gameElo.toLocaleString()}
            {rated ? '' : ' · unrated'}
          </span>
        </div>
        <SparClocks userColor={userColor} />
        {!isLeaf ? (
          <p className="sparring__note muted">
            Step to the last move to carry on, or play a move here to branch the game.
          </p>
        ) : null}
        <div className="sparring__actions">
          <Button onClick={takeBack} type="button">
            <Undo2 size={14} /> Take back
          </Button>
          <Button onClick={resign} type="button" variant="ghost">
            <Flag size={14} /> Resign
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="sparring">
      <div className="sparring__status" aria-live="polite">
        <strong>{outcome ? describeOutcome(outcome) : 'Game over.'}</strong>
        <span className="muted">
          {rated
            ? eloChange
              ? `Next opponent: ${(gameElo + eloChange).toLocaleString()} (${eloChange > 0 ? '+' : ''}${eloChange})`
              : `Next opponent stays at ${gameElo.toLocaleString()}.`
            : 'Unrated game.'}
        </span>
      </div>
      <SparClocks userColor={userColor} />
      <p className="sparring__review muted" aria-live="polite">
        {describeReviewStatus({ savedGameId, mistakesPosted, reviewSettled })}
      </p>
      <div className="sparring__actions">
        <Button onClick={() => newGame(userColor)} type="button" variant="primary">
          <RotateCcw size={14} /> Rematch
        </Button>
        <Button onClick={() => close({ review: true })} type="button">
          <Swords size={14} /> New game
        </Button>
      </div>
    </div>
  )
}

/** Both clocks, the opponent's above yours as on the board; nothing in an untimed game. */
function SparClocks({ userColor }: { userColor: SparColor }) {
  const clocks = useSparStore((state) => state.clocks)
  const clockSide = useSparStore((state) => state.clockSide)
  const turnStartedAt = useSparStore((state) => state.turnStartedAt)
  const [now, setNow] = useState(() => Date.now())

  // Tenths only show under ten seconds; above that the display changes once a
  // second, so it is redrawn at each second boundary rather than ten times a
  // second for the whole game.
  useEffect(() => {
    if (!clockSide || !clocks) return
    let timer: number | undefined
    const tick = () => {
      const current = Date.now()
      setNow(current)
      const left = clockRemaining({ clocks, clockSide, turnStartedAt }, clockSide, current) ?? 0
      if (left <= 0) return
      const delay = left < 10_000 ? 100 : ((left - 1) % 1000) + 1
      timer = window.setTimeout(tick, delay)
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [clockSide, clocks, turnStartedAt])

  if (!clocks) return null
  const state = { clocks, clockSide, turnStartedAt }
  const opponent: SparColor = userColor === 'white' ? 'black' : 'white'
  return (
    <div className="sparring__clocks">
      {[
        { side: opponent, label: 'Stockfish' },
        { side: userColor, label: 'You' },
      ].map(({ side, label }) => {
        const remaining = clockRemaining(state, side, clockSide ? now : 0) ?? 0
        return (
          <div
            className="sparring__clock"
            data-running={clockSide === side || undefined}
            data-low={remaining < 20_000 || undefined}
            key={side}
          >
            <span>{label}</span>
            <strong>{formatClock(remaining)}</strong>
          </div>
        )
      })}
    </div>
  )
}

const RESULT_MARK = { win: 'W', draw: 'D', loss: 'L' } as const

/** The record against the engine, and the strength it has settled on. */
function SparringRecord({
  history,
  onOpen,
}: {
  history: SparringHistory
  onOpen: (game: SparringHistory['games'][number]) => void
}) {
  const { summary, games } = history
  const moved =
    summary.first_rating != null &&
    summary.latest_rating != null &&
    summary.first_rating !== summary.latest_rating
  return (
    <section className="sparring__record" aria-label="Games against the engine">
      <div className="sparring__record-head">
        <strong>
          {summary.wins.toLocaleString()}–{summary.draws.toLocaleString()}–
          {summary.losses.toLocaleString()}
        </strong>
        <span className="muted">
          won–drawn–lost in {summary.played.toLocaleString()}{' '}
          {summary.played === 1 ? 'game' : 'games'}
          {moved
            ? ` · opponent ${summary.first_rating!.toLocaleString()} → ${summary.latest_rating!.toLocaleString()}`
            : ''}
        </span>
      </div>
      <ol className="sparring__games">
        {games.map((game) => (
          <li key={game.id}>
            {/* Every game is kept: a row puts it back on the board with its review. */}
            <button
              aria-label={`Open the game as ${game.user_color} against ${game.engine_rating}, ${formatGameDate(game.played_at)}`}
              className="sparring__game"
              disabled={!game.moves_uci.length}
              onClick={() => onOpen(game)}
              type="button"
            >
              <span className="sparring__result" data-result={game.result}>
                {RESULT_MARK[game.result]}
              </span>
              <span>
                {game.user_color === 'white' ? 'White' : 'Black'} vs{' '}
                {game.engine_rating.toLocaleString()}
                {game.rated ? '' : ' · unrated'}
              </span>
              <span className="muted">
                {formatGameDate(game.played_at)} · {Math.ceil(game.moves / 2).toLocaleString()}{' '}
                moves ·{' '}
                {game.mistakes === 0
                  ? 'no drills'
                  : `${game.mistakes.toLocaleString()} ${game.mistakes === 1 ? 'drill' : 'drills'}`}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
