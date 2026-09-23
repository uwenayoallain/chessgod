import { Cpu, X } from 'lucide-react'

import type { OpeningSelection } from '@/hooks/use-board-workspace'
import { useMemo } from 'react'
import { Chessboard, defaultPieces } from 'react-chessboard'

import { EngineBar } from '@/components/analysis/engine-bar'
import { Button } from '@/components/ui/button'
import { BEST_MOVE_ARROW_COLOR, THREAT_ARROW_COLOR } from '@/lib/analysis/board-guidance'
import { shouldShowBoardAnnotations } from '@/lib/board-annotations'
import { useEngine } from '@/hooks/use-engine'
import type { WorkspaceGame } from '@/hooks/use-workspace-data'
import { useChessGame } from '@/hooks/use-chess-game'
import { useMoveMarkers } from '@/hooks/use-move-markers'
import { formatGameDate } from '@/lib/format-date'
import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'
import { useIsSparring } from '@/store/spar-store'

const PIECE_FILL = { w: '#ffffff', b: '#312e2b' } as const
const PIECE_COLOR = { w: 'White', b: 'Black' } as const
const PIECE_NAME = {
  P: 'pawn',
  N: 'knight',
  B: 'bishop',
  R: 'rook',
  Q: 'queen',
  K: 'king',
} as const

function describePiece(key: string) {
  const color = PIECE_COLOR[key[0] as keyof typeof PIECE_COLOR]
  const piece = PIECE_NAME[key[1] as keyof typeof PIECE_NAME]
  return color && piece ? `${color} ${piece}` : key
}

/**
 * react-chessboard wraps every piece in its own `role="button"` draggable with
 * no accessible name, so a keyboard user meets thirty-two anonymous buttons.
 * A labelled `role="img"` inside gives that button a name from its content.
 */
const pieces = Object.fromEntries(
  Object.entries(defaultPieces).map(([key, Piece]) => [
    key,
    (props: { fill?: string; svgStyle?: React.CSSProperties }) => (
      // The wrapper must be an <svg>, not a <span>. dnd-kit measures a
      // draggable by its first child when that child is an HTMLElement, and
      // otherwise by the draggable itself — so an HTML wrapper made the
      // dragged piece size itself from the overlay instead of from its square
      // and it came out bigger than the board. An SVGElement leaves the
      // measurement alone while still carrying the accessible name.
      <svg
        aria-label={describePiece(key)}
        height="100%"
        role="img"
        viewBox="0 0 45 45"
        width="100%"
      >
        <Piece {...props} fill={PIECE_FILL[key[0] as 'w' | 'b']} />
      </svg>
    ),
  ]),
) as typeof defaultPieces

export function ChessBoard({
  activeGame,
  selectedOpening,
  onClearContext,
  username,
}: {
  activeGame?: WorkspaceGame | null
  selectedOpening?: OpeningSelection | null
  onClearContext?: () => void
  username?: string | null
}) {
  const boardOrientation = useAppStore((state) => state.boardOrientation)
  const { position, squareStyles, onPieceDrag, onPieceDrop, onSquareClick } = useChessGame()
  const { enabled, toggle, isLoadingNnue } = useEngine({ autoAnalyze: false })
  const engineDepth = useEngineStore((state) => state.engineDepth)
  const setEngineDepth = useEngineStore((state) => state.setEngineDepth)

  const isSolvingDrill = useAppStore((state) => state.drillSolving)
  const sparring = useIsSparring()
  const showAnnotations = shouldShowBoardAnnotations({
    hasActiveGame: Boolean(activeGame),
    hasSelectedOpening: Boolean(selectedOpening),
    // A sparring game is a question being answered move by move, like a drill.
    isSolvingDrill: isSolvingDrill || sparring,
  })
  const { squareRenderer, customArrows } = useMoveMarkers(showAnnotations, squareStyles)

  const gameMetadata = useMemo(() => {
    if (!activeGame) return null

    const formatDate = formatGameDate

    const getResultForPlayer = (playerColor: string) => {
      if (activeGame.result === '1/2-1/2') return 'draw'
      if (activeGame.result === '1-0') {
        return playerColor === 'white' ? 'win' : 'loss'
      }
      if (activeGame.result === '0-1') {
        return playerColor === 'black' ? 'win' : 'loss'
      }
      return null
    }

    const topPlayerColor = boardOrientation === 'white' ? 'black' : 'white'
    const bottomPlayerColor = boardOrientation === 'white' ? 'white' : 'black'

    return {
      date: formatDate(activeGame.played_at),
      timeClass: activeGame.time_class,
      topPlayerResult: getResultForPlayer(topPlayerColor),
      bottomPlayerResult: getResultForPlayer(bottomPlayerColor),
    }
  }, [activeGame, boardOrientation])

  const players = useMemo(() => {
    if (!activeGame) {
      return null
    }

    const userName = username ?? activeGame.username
    const whiteIsUser = activeGame.user_color === 'white'
    const blackIsUser = activeGame.user_color === 'black'
    const topPlayer =
      boardOrientation === 'white'
        ? {
            name: activeGame.black_username,
            role: blackIsUser ? 'You' : 'Opponent',
          }
        : {
            name: activeGame.white_username,
            role: whiteIsUser ? 'You' : 'Opponent',
          }
    const bottomPlayer =
      boardOrientation === 'white'
        ? {
            name: activeGame.white_username,
            role: whiteIsUser ? 'You' : 'Opponent',
          }
        : {
            name: activeGame.black_username,
            role: blackIsUser ? 'You' : 'Opponent',
          }

    return {
      top: {
        ...topPlayer,
        isUser: topPlayer.name === userName || topPlayer.role === 'You',
      },
      bottom: {
        ...bottomPlayer,
        isUser: bottomPlayer.name === userName || bottomPlayer.role === 'You',
      },
    }
  }, [activeGame, boardOrientation, username])

  const options = useMemo(
    () => ({
      position,
      boardOrientation,
      onPieceDrag,
      onPieceDrop,
      onSquareClick,
      squareStyles,
      squareRenderer,
      arrows: customArrows,
      pieces,
      arrowOptions: {
        color: BEST_MOVE_ARROW_COLOR,
        secondaryColor: 'rgba(70, 140, 200, 0.8)',
        tertiaryColor: THREAT_ARROW_COLOR,
        arrowLengthReducerDenominator: 8,
        sameTargetArrowLengthReducerDenominator: 4,
        arrowWidthDenominator: 6,
        activeArrowWidthMultiplier: 0.9,
        opacity: 0.88,
        activeOpacity: 0.72,
        arrowStartOffset: 0.18,
      },
      darkSquareStyle: { backgroundColor: 'var(--board-dark)' } as React.CSSProperties,
      lightSquareStyle: { backgroundColor: 'var(--board-light)' } as React.CSSProperties,
      darkSquareNotationStyle: {
        color: 'var(--board-light)',
        fontSize: '11px',
        fontWeight: 600,
        opacity: 0.7,
      } as React.CSSProperties,
      lightSquareNotationStyle: {
        color: 'var(--board-dark)',
        fontSize: '11px',
        fontWeight: 600,
        opacity: 0.9,
      } as React.CSSProperties,
      animationDurationInMs: 150,
      boardStyle: {
        width: '100%',
        height: '100%',
      } as React.CSSProperties,
    }),
    [
      position,
      boardOrientation,
      onPieceDrag,
      onPieceDrop,
      onSquareClick,
      squareStyles,
      squareRenderer,
      customArrows,
    ],
  )

  return (
    <div className="board-container">
      <div className="board-engine">
        <Button
          aria-label={enabled ? 'Disable engine' : 'Enable engine'}
          className="board-engine__toggle"
          // The opponent is this engine: switching it off mid-game stops it.
          disabled={sparring}
          onClick={() => void toggle()}
          type="button"
          variant={enabled ? 'primary' : 'default'}
        >
          <Cpu size={15} />
          <span>Engine</span>
        </Button>
        {enabled ? (
          <select
            aria-label="Analysis depth"
            className="board-engine__depth-select"
            disabled={sparring}
            onChange={(e) => setEngineDepth(Number(e.target.value))}
            value={engineDepth}
          >
            <option value={18}>d18</option>
            <option value={22}>d22</option>
            <option value={26}>d26</option>
            <option value={30}>d30</option>
            <option value={34}>d34</option>
          </select>
        ) : null}
        {enabled && isLoadingNnue ? (
          <span className="board-engine__status">Loading neural network…</span>
        ) : null}
        {sparring ? (
          <span className="board-engine__status">Evaluation hidden while you play</span>
        ) : (
          <EngineBar />
        )}
      </div>
      <div className="board-container__inner">
        <div className="board-frame">
          {!players && selectedOpening ? (
            <div className="board-frame__context">
              <span className="board-frame__context-label">
                {selectedOpening.eco ? `${selectedOpening.eco} · ` : ''}
                {selectedOpening.openingName}
              </span>
              {onClearContext ? (
                <button
                  className="board-frame__context-clear"
                  onClick={onClearContext}
                  type="button"
                  title="Clear opening"
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>
          ) : null}
          {players ? (
            <div className="board-frame__player board-frame__player--top">
              <div className="board-frame__player-id">
                <span className="board-frame__player-name">{players.top.name}</span>
                <span
                  className={`board-frame__player-role${players.top.isUser ? ' board-frame__player-role--user' : ''}`}
                >
                  {players.top.role}
                </span>
              </div>
              {gameMetadata ? (
                <div className="board-frame__player-meta">
                  <span className="board-frame__player-date">{gameMetadata.date}</span>
                  {gameMetadata.topPlayerResult ? (
                    <span
                      className={`board-frame__player-result board-frame__player-result--${gameMetadata.topPlayerResult}`}
                    >
                      {gameMetadata.topPlayerResult === 'win'
                        ? 'Won'
                        : gameMetadata.topPlayerResult === 'loss'
                          ? 'Lost'
                          : 'Draw'}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="board-frame__board">
            <Chessboard options={options} />
          </div>
          {players ? (
            <div className="board-frame__player board-frame__player--bottom">
              <div className="board-frame__player-id">
                <span className="board-frame__player-name">{players.bottom.name}</span>
                <span
                  className={`board-frame__player-role${players.bottom.isUser ? ' board-frame__player-role--user' : ''}`}
                >
                  {players.bottom.role}
                </span>
              </div>
              {gameMetadata ? (
                <div className="board-frame__player-meta">
                  <span className="badge">{gameMetadata.timeClass}</span>
                  {gameMetadata.bottomPlayerResult ? (
                    <span
                      className={`board-frame__player-result board-frame__player-result--${gameMetadata.bottomPlayerResult}`}
                    >
                      {gameMetadata.bottomPlayerResult === 'win'
                        ? 'Won'
                        : gameMetadata.bottomPlayerResult === 'loss'
                          ? 'Lost'
                          : 'Draw'}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
