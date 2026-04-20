import { Cpu, X } from 'lucide-react'

import type { OpeningSelection } from '@/hooks/use-board-workspace'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Chessboard } from 'react-chessboard'

import { EngineBar } from '@/components/analysis/engine-bar'
import { Button } from '@/components/ui/button'
import { shouldShowBoardAnnotations } from '@/lib/board-annotations'
import { useEngine } from '@/hooks/use-engine'
import type { WorkspaceGame } from '@/hooks/use-workspace-data'
import { useChessGame } from '@/hooks/use-chess-game'
import { useMoveMarkers } from '@/hooks/use-move-markers'
import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'

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
  const { position, squareStyles, onPieceDrop, onSquareClick } = useChessGame()
  const { enabled, toggle, isLoadingNnue } = useEngine()
  const engineDepth = useEngineStore((state) => state.engineDepth)
  const setEngineDepth = useEngineStore((state) => state.setEngineDepth)
  const containerRef = useRef<HTMLDivElement>(null)
  const [boardWidth, setBoardWidth] = useState(400)

  const showAnnotations = shouldShowBoardAnnotations({
    hasActiveGame: Boolean(activeGame),
    hasSelectedOpening: Boolean(selectedOpening),
  })
  const { squareRenderer, customArrows } = useMoveMarkers(showAnnotations)

  const gameMetadata = useMemo(() => {
    if (!activeGame) return null
    
    const formatDate = (dateStr: string) => {
      return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    }
    
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

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        const size = Math.min(width - 8, height - 8)
        setBoardWidth(Math.max(280, size))
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const options = useMemo(
    () => ({
      position,
      boardOrientation,
      onPieceDrop,
      onSquareClick,
      squareStyles,
      squareRenderer,
      arrows: customArrows,
      arrowOptions: {
        color: 'rgba(20, 184, 166, 0.72)',
        secondaryColor: 'rgba(20, 184, 166, 0.72)',
        tertiaryColor: 'rgba(239, 68, 68, 0.72)',
        arrowLengthReducerDenominator: 8,
        sameTargetArrowLengthReducerDenominator: 4,
        arrowWidthDenominator: 6,
        activeArrowWidthMultiplier: 0.9,
        opacity: 0.88,
        activeOpacity: 0.72,
        arrowStartOffset: 0.18,
      },
      darkSquareStyle: { backgroundColor: '#769656' } as React.CSSProperties,
      lightSquareStyle: { backgroundColor: '#eeeed2' } as React.CSSProperties,
      animationDurationInMs: 200,
      boardStyle: {
        width: `${boardWidth}px`,
        height: `${boardWidth}px`,
        maxWidth: '100%',
        maxHeight: '100%',
      } as React.CSSProperties,
    }),
    [position, boardOrientation, onPieceDrop, onSquareClick, squareStyles, squareRenderer, customArrows, boardWidth],
  )

  return (
    <div className="board-container">
      <div className="board-engine">
        <Button
          aria-label={enabled ? 'Disable engine' : 'Enable engine'}
          className="board-engine__toggle"
          onClick={() => void toggle()}
          type="button"
          variant={enabled ? 'primary' : 'default'}
        >
          <Cpu size={16} />
        </Button>
        {enabled ? (
          <select
            className="select"
            style={{ width: '48px', padding: '2px 4px', fontSize: '11px', textAlign: 'center', background: 'var(--surface-2)', border: 'none' }}
            onChange={(e) => setEngineDepth(Number(e.target.value))}
            value={engineDepth}
          >
            <option value={16}>d16</option>
            <option value={18}>d18</option>
            <option value={20}>d20</option>
            <option value={22}>d22</option>
            <option value={26}>d26</option>
          </select>
        ) : null}
        {enabled && isLoadingNnue ? (
          <span className="board-engine__status">NNUE…</span>
        ) : null}
        <EngineBar />
      </div>
      <div className="board-container__inner">
        <div className="board-frame">
          {!players && selectedOpening ? (
            <div className="board-frame__context">
              <span className="board-frame__context-label">
                {selectedOpening.eco ? `${selectedOpening.eco} · ` : ''}{selectedOpening.openingName}
              </span>
              {onClearContext ? (
                <button className="board-frame__context-clear" onClick={onClearContext} type="button" title="Clear opening">
                  <X size={12} />
                </button>
              ) : null}
            </div>
          ) : (
            <div className="board-frame__context" style={{ visibility: 'hidden' }}>
              <span className="board-frame__context-label">&nbsp;</span>
            </div>
          )}
          {players ? (
            <div className="board-frame__player board-frame__player--top">
              <div className="board-frame__player-id">
                <span className="board-frame__player-name">{players.top.name}</span>
                <span className={`board-frame__player-role${players.top.isUser ? ' board-frame__player-role--user' : ''}`}>{players.top.role}</span>
              </div>
              {gameMetadata ? (
                <div className="board-frame__player-meta">
                  <span className="board-frame__player-date">{gameMetadata.date}</span>
                  {gameMetadata.topPlayerResult ? (
                    <span className={`board-frame__player-result board-frame__player-result--${gameMetadata.topPlayerResult}`}>
                      {gameMetadata.topPlayerResult === 'win' ? 'Won' : gameMetadata.topPlayerResult === 'loss' ? 'Lost' : 'Draw'}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="board-frame__player board-frame__player--top" style={{ visibility: 'hidden' }}>
              <div><span className="board-frame__player-name">&nbsp;</span></div>
            </div>
          )}
          <div className="board-frame__board" ref={containerRef}>
            <Chessboard options={options} />
          </div>
          {players ? (
            <div className="board-frame__player board-frame__player--bottom">
              <div className="board-frame__player-id">
                <span className="board-frame__player-name">{players.bottom.name}</span>
                <span className={`board-frame__player-role${players.bottom.isUser ? ' board-frame__player-role--user' : ''}`}>{players.bottom.role}</span>
              </div>
              {gameMetadata ? (
                <div className="board-frame__player-meta">
                  <span className="badge">{gameMetadata.timeClass}</span>
                  {gameMetadata.bottomPlayerResult ? (
                    <span className={`board-frame__player-result board-frame__player-result--${gameMetadata.bottomPlayerResult}`}>
                      {gameMetadata.bottomPlayerResult === 'win' ? 'Won' : gameMetadata.bottomPlayerResult === 'loss' ? 'Lost' : 'Draw'}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="board-frame__player board-frame__player--bottom" style={{ visibility: 'hidden' }}>
              <div><span className="board-frame__player-name">&nbsp;</span></div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
