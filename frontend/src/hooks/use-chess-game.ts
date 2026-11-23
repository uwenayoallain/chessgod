import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { Chess, type Square } from 'chess.js'

import { buildLatestMoveSquareStyles } from '@/lib/analysis/board-guidance'
import { computeLegalDests } from '@/lib/chess-utils'
import { useAppStore } from '@/store/app-store'

const SELECTED_SQUARE = 'rgba(255, 255, 51, 0.5)'
const MOVE_DOT = 'radial-gradient(circle, rgba(0, 0, 0, 0.16) 19%, transparent 20%)'
const CAPTURE_RING =
  'radial-gradient(circle, transparent 0 77%, rgba(0, 0, 0, 0.16) 78% 88%, transparent 89%)'

export function useChessGame() {
  const { currentFen, currentNodeId, nodes, pushPosition } = useAppStore()
  const [selected, setSelected] = useState<Square | null>(null)

  const chess = useMemo(() => new Chess(currentFen), [currentFen])
  const legalDests = useMemo(() => computeLegalDests(chess), [chess])
  const latestMoveStyles = useMemo(
    () => buildLatestMoveSquareStyles(nodes[currentNodeId]?.uci),
    [nodes, currentNodeId],
  )

  useEffect(() => {
    setSelected(null)
  }, [currentFen])

  const squareStyles = useMemo(() => {
    const styles: Record<string, CSSProperties> = { ...latestMoveStyles }

    if (selected) {
      styles[selected] = {
        ...styles[selected],
        backgroundImage: `linear-gradient(${SELECTED_SQUARE}, ${SELECTED_SQUARE})`,
      }
      const targets = legalDests.get(selected)
      if (targets) {
        for (const sq of targets) {
          // An empty destination gets a dot; one holding a piece gets a ring
          // around it, so a capture is readable without moving the piece.
          const marker = chess.get(sq as Square) ? CAPTURE_RING : MOVE_DOT
          const existing = styles[sq]?.backgroundImage
          styles[sq] = {
            ...styles[sq],
            backgroundImage: existing ? `${marker}, ${existing}` : marker,
          }
        }
      }
    }

    return styles
  }, [chess, selected, latestMoveStyles, legalDests])

  function onPieceDrop({
    sourceSquare,
    targetSquare,
  }: {
    piece: unknown
    sourceSquare: string
    targetSquare: string | null
  }): boolean {
    if (!targetSquare) return false
    try {
      const move = chess.move({
        from: sourceSquare as Square,
        to: targetSquare as Square,
        promotion: 'q',
      })
      if (move) {
        pushPosition(
          chess.fen().split(' ').slice(0, 4).join(' '),
          move.san,
          move.from + move.to + (move.promotion ?? ''),
        )
        setSelected(null)
        return true
      }
    } catch {
      // invalid move
    }
    return false
  }

  /**
   * Picking a piece up should show its destinations, the same as clicking it.
   * Without this the dots only ever appear on click, and dragging — the more
   * common gesture — gives no indication of where the piece may legally go.
   */
  function onPieceDrag({
    square,
  }: {
    isSparePiece?: boolean
    piece?: unknown
    square: string | null
  }) {
    if (!square) return
    const sq = square as Square
    setSelected(legalDests.has(sq) ? sq : null)
  }

  function onSquareClick({ square }: { piece: unknown; square: string }) {
    const sq = square as Square

    if (!selected) {
      if (legalDests.has(sq)) {
        setSelected(sq)
      }
      return
    }

    try {
      const move = chess.move({ from: selected, to: sq, promotion: 'q' })
      if (move) {
        pushPosition(
          chess.fen().split(' ').slice(0, 4).join(' '),
          move.san,
          move.from + move.to + (move.promotion ?? ''),
        )
        setSelected(null)
        return
      }
    } catch {
      // not a valid move to this square
    }

    if (legalDests.has(sq)) {
      setSelected(sq)
    } else {
      setSelected(null)
    }
  }

  return {
    position: currentFen,
    squareStyles,
    onPieceDrag,
    onPieceDrop,
    onSquareClick,
  }
}
