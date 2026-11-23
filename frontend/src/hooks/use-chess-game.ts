import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chess, type Square } from 'chess.js'

import { buildLatestMoveSquareStyles } from '@/lib/analysis/board-guidance'
import { computeLegalDests } from '@/lib/chess-utils'
import { useAppStore } from '@/store/app-store'

export type PromotionPiece = 'q' | 'r' | 'b' | 'n'

/** A pawn that has reached the last rank and is waiting to be told what it becomes. */
export type PendingPromotion = { from: Square; to: Square; color: 'w' | 'b' }

type MoveOutcome = 'moved' | 'promotion' | 'illegal'

/**
 * Whether moving `from` to `to` is a legal pawn promotion in this position,
 * and for which side. A pawn merely pointed at the last rank is not one: the
 * move has to be legal, or the chooser would open for a pinned pawn and then
 * refuse every piece.
 */
export function promotionFor(fen: string, from: string, to: string): PendingPromotion | null {
  try {
    const board = new Chess(fen)
    const piece = board.get(from as Square)
    if (!piece || piece.type !== 'p') return null
    if (to[1] !== (piece.color === 'w' ? '8' : '1')) return null
    const legal = board
      .moves({ square: from as Square, verbose: true })
      .some((move) => move.to === to && Boolean(move.promotion))
    return legal ? { from: from as Square, to: to as Square, color: piece.color } : null
  } catch {
    return null
  }
}

const SELECTED_SQUARE = 'rgba(255, 255, 51, 0.5)'
const MOVE_DOT = 'radial-gradient(circle, rgba(0, 0, 0, 0.16) 19%, transparent 20%)'
const CAPTURE_RING =
  'radial-gradient(circle, transparent 0 77%, rgba(0, 0, 0, 0.16) 78% 88%, transparent 89%)'

export function useChessGame() {
  const currentFen = useAppStore((s) => s.currentFen)
  const lastMoveUci = useAppStore((s) => s.nodes[s.currentNodeId]?.uci ?? null)
  // Read only to notice the board being replaced or stepped without its FEN
  // changing: the same position reloaded (a drill's "Try again"), or another
  // node that transposes into it.
  const currentNodeId = useAppStore((s) => s.currentNodeId)
  const treeEpoch = useAppStore((s) => s.treeEpoch)
  const [selected, setSelected] = useState<Square | null>(null)
  const selectedRef = useRef<Square | null>(null)
  selectedRef.current = selected
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null)
  const pendingRef = useRef<PendingPromotion | null>(null)
  pendingRef.current = pendingPromotion

  const chess = useMemo(() => new Chess(currentFen), [currentFen])
  const legalDests = useMemo(() => computeLegalDests(chess), [chess])
  const legalDestsRef = useRef(legalDests)
  legalDestsRef.current = legalDests
  const latestMoveStyles = useMemo(() => buildLatestMoveSquareStyles(lastMoveUci), [lastMoveUci])

  useEffect(() => {
    selectedRef.current = null
    setSelected(null)
    // A chooser belongs to the position it was opened in, and to that visit
    // to it: the FEN alone does not change when the same position is loaded
    // again, and the chooser then stayed open over a board it was not for.
    pendingRef.current = null
    setPendingPromotion(null)
  }, [currentFen, currentNodeId, treeEpoch])

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

  const clearSelection = useCallback(() => {
    selectedRef.current = null
    setSelected(null)
  }, [])

  /**
   * The one way a move reaches the board, whether dragged, clicked or chosen
   * from the promotion chooser. Without a `promotion` a pawn reaching the last
   * rank is not played: it is held as `pendingPromotion` until a piece is
   * chosen. Every promotion used to be played as a queen, so a knight (the
   * only winning move in some endings, and the answer to some drills) could
   * not be played at all.
   */
  const tryMove = useCallback(
    (from: string, to: string, promotion?: PromotionPiece): MoveOutcome => {
      const { currentFen: fen, pushPosition } = useAppStore.getState()
      if (!promotion) {
        const pending = promotionFor(fen, from, to)
        if (pending) {
          // The ref is what `choosePromotion` reads; it must not wait for the
          // render that follows the state.
          pendingRef.current = pending
          setPendingPromotion(pending)
          clearSelection()
          return 'promotion'
        }
      }
      try {
        const board = new Chess(fen)
        const move = board.move({ from: from as Square, to: to as Square, promotion })
        if (!move) return 'illegal'
        pushPosition(
          board.fen().split(' ').slice(0, 4).join(' '),
          move.san,
          move.from + move.to + (move.promotion ?? ''),
        )
        clearSelection()
        return 'moved'
      } catch {
        // Not a legal move from this position.
        return 'illegal'
      }
    },
    [clearSelection],
  )

  const choosePromotion = useCallback(
    (piece: PromotionPiece) => {
      const pending = pendingRef.current
      if (!pending) return
      // Cleared here, not on the next render: a second press in the same tick
      // (or one landing after a cancel) must find nothing left to promote.
      pendingRef.current = null
      setPendingPromotion(null)
      tryMove(pending.from, pending.to, piece)
    },
    [tryMove],
  )

  const cancelPromotion = useCallback(() => {
    pendingRef.current = null
    setPendingPromotion(null)
  }, [])

  const onPieceDrop = useCallback(
    ({
      sourceSquare,
      targetSquare,
    }: {
      piece: unknown
      sourceSquare: string
      targetSquare: string | null
    }): boolean => {
      if (!targetSquare) return false
      // A promotion waiting for its piece returns false: the pawn goes back to
      // its square and the chooser stands on the one it was dropped on.
      return tryMove(sourceSquare, targetSquare) === 'moved'
    },
    [tryMove],
  )

  /**
   * Picking a piece up should show its destinations, the same as clicking it.
   * Without this the dots only ever appear on click, and dragging, the more
   * common gesture, gives no indication of where the piece may legally go.
   */
  const onPieceDrag = useCallback(
    ({ square }: { isSparePiece?: boolean; piece?: unknown; square: string | null }) => {
      if (!square) return
      const sq = square as Square
      const next = legalDestsRef.current.has(sq) ? sq : null
      selectedRef.current = next
      setSelected(next)
    },
    [],
  )

  const onSquareClick = useCallback(
    ({ square }: { piece: unknown; square: string }) => {
      const sq = square as Square
      const currentSelected = selectedRef.current
      const dests = legalDestsRef.current

      if (!currentSelected) {
        if (dests.has(sq)) {
          selectedRef.current = sq
          setSelected(sq)
        }
        return
      }

      // Played, or held for the promotion chooser: either way the click is spent.
      if (tryMove(currentSelected, sq) !== 'illegal') return

      const next = dests.has(sq) ? sq : null
      selectedRef.current = next
      setSelected(next)
    },
    [tryMove],
  )

  return {
    position: currentFen,
    squareStyles,
    onPieceDrag,
    onPieceDrop,
    onSquareClick,
    tryMove,
    pendingPromotion,
    choosePromotion,
    cancelPromotion,
  }
}
