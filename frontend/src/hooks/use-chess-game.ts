import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { Chess, type Square } from 'chess.js'

import { buildLatestMoveSquareStyles } from '@/lib/analysis/board-guidance'
import { computeLegalDests } from '@/lib/chess-utils'
import { useAppStore } from '@/store/app-store'

export function useChessGame() {
  const { currentFen, currentNodeId, nodes, pushPosition } = useAppStore()
  const [selected, setSelected] = useState<Square | null>(null)

  const chess = useMemo(() => new Chess(currentFen), [currentFen])
  const legalDests = useMemo(() => computeLegalDests(chess), [chess])
  const latestMoveStyles = useMemo(() => buildLatestMoveSquareStyles(nodes[currentNodeId]?.uci), [nodes, currentNodeId])

  useEffect(() => {
    setSelected(null)
  }, [currentFen])

  const squareStyles = useMemo(() => {
    const styles: Record<string, CSSProperties> = { ...latestMoveStyles }

    if (selected) {
      styles[selected] = {
        ...styles[selected],
        backgroundColor: 'rgba(255, 255, 51, 0.45)',
      }
      const targets = legalDests.get(selected)
      if (targets) {
        for (const sq of targets) {
          styles[sq] = {
            ...styles[sq],
            background:
              `${styles[sq]?.backgroundColor ? `${styles[sq].backgroundColor}, ` : ''}` +
              'radial-gradient(circle, rgba(0,0,0,0.2) 25%, transparent 25%)',
            borderRadius: '50%',
          }
        }
      }
    }

    return styles
  }, [selected, latestMoveStyles, legalDests])

  function onPieceDrop({ sourceSquare, targetSquare }: { piece: unknown; sourceSquare: string; targetSquare: string | null }): boolean {
    if (!targetSquare) return false
    try {
      const move = chess.move({
        from: sourceSquare as Square,
        to: targetSquare as Square,
        promotion: 'q',
      })
      if (move) {
        pushPosition(chess.fen().split(' ').slice(0, 4).join(' '), move.san, move.from + move.to + (move.promotion ?? ''))
        setSelected(null)
        return true
      }
    } catch {
      // invalid move
    }
    return false
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
        pushPosition(chess.fen().split(' ').slice(0, 4).join(' '), move.san, move.from + move.to + (move.promotion ?? ''))
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
    onPieceDrop,
    onSquareClick,
  }
}
