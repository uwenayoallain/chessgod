import { Flag, Minus, Plus, RotateCcw, Swords, Undo2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useAnalyzeLine } from '@/hooks/use-analyze-line'
import { QUICK_REVIEW_DEPTH } from '@/lib/analysis/review-depth'
import { useStartSparring } from '@/hooks/use-sparring'
import {
  clampSparRating,
  describeOutcome,
  sideToMove,
  SPAR_ELO_STEP,
  type SparColor,
} from '@/lib/sparring/sparring'
import { STARTING_FEN, useAppStore, type MoveNode } from '@/store/app-store'
import { readSparStrength, useSparStore } from '@/store/spar-store'

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
  const { analyzeLine } = useAnalyzeLine()
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
        {!atStart ? (
          <Button className="sparring__from-here" onClick={playFromHere} type="button">
            Play this position out ({sideToMove(currentFen) === 'white' ? 'White' : 'Black'} to
            move)
          </Button>
        ) : null}
        <p className="sparring__note muted">
          Stockfish looks a few moves ahead and chooses the way a player at this rating does, tuned
          to your own games — so its mistakes are missed tactics, not random blunders. It gets{' '}
          {SPAR_ELO_STEP} stronger after each win and {SPAR_ELO_STEP} weaker after each loss. A
          strength you pick with − / + lasts until you reset or reload, and those games are unrated,
          like set-up positions and takebacks. The evaluation stays hidden until the game ends.
        </p>
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
            You have {userColor === 'white' ? 'White' : 'Black'} · Stockfish plays like ≈{' '}
            {gameElo.toLocaleString()}
            {rated ? '' : ' · unrated'}
          </span>
        </div>
        {!isLeaf ? (
          <p className="sparring__note muted">
            Step forward to the last move to continue, or play a different move here to take the
            game back from this point.
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
            : 'Unrated game — the opponent’s strength is unchanged.'}
        </span>
      </div>
      <div className="sparring__actions">
        <Button
          onClick={() => {
            // Reveal the engine and grade every move of the game just played,
            // the same run "Review this game" starts for an imported game.
            close({ review: true })
            void analyzeLine({ depth: QUICK_REVIEW_DEPTH })
          }}
          type="button"
          variant="primary"
        >
          Review with the engine
        </Button>
        <Button onClick={() => newGame(userColor)} type="button">
          <RotateCcw size={14} /> Rematch
        </Button>
      </div>
    </div>
  )
}
