// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { PromotionChooser } from '@/components/board/chess-board'
import { useAppStore } from '@/store/app-store'

import { promotionFor, useChessGame } from './use-chess-game'

// A white pawn one step from promoting, kings out of the way.
const PAWN_ON_A7 = '8/P7/8/8/8/8/8/k6K w - - 0 1'

function lastMove() {
  const state = useAppStore.getState()
  return state.nodes[state.currentNodeId]
}

afterEach(cleanup)

describe('promotion', () => {
  beforeEach(() => {
    useAppStore.getState().loadPosition(PAWN_ON_A7)
  })

  it('holds a pawn reaching the last rank instead of queening it', () => {
    const { result } = renderHook(() => useChessGame())

    let accepted = true
    act(() => {
      accepted = result.current.onPieceDrop({
        piece: null,
        sourceSquare: 'a7',
        targetSquare: 'a8',
      })
    })

    // Nothing is played yet: the pawn goes back and the chooser opens.
    expect(accepted).toBe(false)
    expect(result.current.pendingPromotion).toEqual({ from: 'a7', to: 'a8', color: 'w' })
    expect(useAppStore.getState().currentFen).toBe(PAWN_ON_A7)
    expect(lastMove().san).toBeNull()
  })

  it('plays a7a8 as a knight when the knight is chosen', () => {
    const { result } = renderHook(() => useChessGame())

    act(() => {
      result.current.onPieceDrop({ piece: null, sourceSquare: 'a7', targetSquare: 'a8' })
    })
    act(() => {
      result.current.choosePromotion('n')
    })

    expect(lastMove().uci).toBe('a7a8n')
    expect(lastMove().san).toBe('a8=N')
    expect(useAppStore.getState().currentFen.startsWith('N7/8/')).toBe(true)
    expect(result.current.pendingPromotion).toBeNull()
  })

  it.each([
    ['q', 'a7a8q'],
    ['r', 'a7a8r'],
    ['b', 'a7a8b'],
  ] as const)('plays the piece chosen: %s', (piece, uci) => {
    const { result } = renderHook(() => useChessGame())
    act(() => {
      result.current.onPieceDrop({ piece: null, sourceSquare: 'a7', targetSquare: 'a8' })
    })
    act(() => {
      result.current.choosePromotion(piece)
    })
    expect(lastMove().uci).toBe(uci)
  })

  it('opens the chooser for a clicked promotion too', () => {
    const { result } = renderHook(() => useChessGame())

    act(() => {
      result.current.onSquareClick({ piece: null, square: 'a7' })
    })
    act(() => {
      result.current.onSquareClick({ piece: null, square: 'a8' })
    })

    expect(result.current.pendingPromotion).toEqual({ from: 'a7', to: 'a8', color: 'w' })
    expect(lastMove().san).toBeNull()
  })

  it('leaves the board as it was when the chooser is cancelled', () => {
    const { result } = renderHook(() => useChessGame())
    act(() => {
      result.current.onPieceDrop({ piece: null, sourceSquare: 'a7', targetSquare: 'a8' })
    })
    act(() => {
      result.current.cancelPromotion()
    })

    expect(result.current.pendingPromotion).toBeNull()
    expect(useAppStore.getState().currentFen).toBe(PAWN_ON_A7)
    // And a choice arriving late plays nothing.
    act(() => {
      result.current.choosePromotion('q')
    })
    expect(lastMove().san).toBeNull()
  })

  it('drops the chooser when the position changes under it', () => {
    const { result } = renderHook(() => useChessGame())
    act(() => {
      result.current.onPieceDrop({ piece: null, sourceSquare: 'a7', targetSquare: 'a8' })
    })
    act(() => {
      useAppStore.getState().loadPosition('8/8/8/8/8/8/P7/k6K w - -')
    })
    expect(result.current.pendingPromotion).toBeNull()
  })

  it('drops the chooser when the same position is loaded again', () => {
    // A drill's "Try again" reloads the position it is already on: the FEN
    // does not change, so the FEN alone cannot be what closes the chooser.
    const { result } = renderHook(() => useChessGame())
    act(() => {
      result.current.onPieceDrop({ piece: null, sourceSquare: 'a7', targetSquare: 'a8' })
    })
    expect(result.current.pendingPromotion).not.toBeNull()
    act(() => {
      useAppStore.getState().loadPosition(PAWN_ON_A7)
    })
    expect(result.current.pendingPromotion).toBeNull()
    // And the piece pressed a moment late promotes nothing on the new board.
    act(() => {
      result.current.choosePromotion('q')
    })
    expect(lastMove().san).toBeNull()
  })

  it('drops the chooser when the board steps to another node with the same position', () => {
    const { result } = renderHook(() => useChessGame())
    act(() => {
      // A transposition: a second node standing on the position already shown.
      useAppStore.getState().pushPosition(PAWN_ON_A7, 'Kh1', 'h2h1')
    })
    act(() => {
      result.current.onPieceDrop({ piece: null, sourceSquare: 'a7', targetSquare: 'a8' })
    })
    expect(result.current.pendingPromotion).not.toBeNull()
    act(() => {
      useAppStore.getState().goBack()
    })
    expect(useAppStore.getState().currentFen).toBe(PAWN_ON_A7)
    expect(result.current.pendingPromotion).toBeNull()
  })

  it('plays nothing for a choice made in the same tick as the cancel', () => {
    // Both handlers read the pending promotion from a ref. Cleared only on the
    // next render, a cancel followed at once by a press still promoted.
    const { result } = renderHook(() => useChessGame())
    act(() => {
      result.current.onPieceDrop({ piece: null, sourceSquare: 'a7', targetSquare: 'a8' })
    })
    act(() => {
      result.current.cancelPromotion()
      result.current.choosePromotion('q')
    })
    expect(lastMove().san).toBeNull()
    expect(useAppStore.getState().currentFen).toBe(PAWN_ON_A7)
  })

  it('promotes once when the piece is pressed twice in one tick', () => {
    const { result } = renderHook(() => useChessGame())
    const pushPosition = vi.spyOn(useAppStore.getState(), 'pushPosition')
    act(() => {
      result.current.onPieceDrop({ piece: null, sourceSquare: 'a7', targetSquare: 'a8' })
    })
    act(() => {
      result.current.choosePromotion('n')
      result.current.choosePromotion('n')
    })
    expect(pushPosition).toHaveBeenCalledTimes(1)
    expect(lastMove().uci).toBe('a7a8n')
    pushPosition.mockRestore()
  })

  it('plays an ordinary move straight away', () => {
    const { result } = renderHook(() => useChessGame())
    let outcome = ''
    act(() => {
      outcome = result.current.tryMove('h1', 'h2')
    })
    expect(outcome).toBe('moved')
    expect(lastMove().uci).toBe('h1h2')
    expect(result.current.pendingPromotion).toBeNull()
  })

  it('refuses an illegal move without opening the chooser', () => {
    const { result } = renderHook(() => useChessGame())
    let outcome = ''
    act(() => {
      outcome = result.current.tryMove('a7', 'b8')
    })
    expect(outcome).toBe('illegal')
    expect(result.current.pendingPromotion).toBeNull()
  })
})

describe('promotionFor', () => {
  it('recognises a promotion for either side', () => {
    expect(promotionFor(PAWN_ON_A7, 'a7', 'a8')).toEqual({ from: 'a7', to: 'a8', color: 'w' })
    expect(promotionFor('K6k/8/8/8/8/8/p7/8 b - - 0 1', 'a2', 'a1')).toEqual({
      from: 'a2',
      to: 'a1',
      color: 'b',
    })
  })

  it('is not fooled by other pieces, other ranks or illegal pawn moves', () => {
    // A king stepping to the last rank is not a promotion.
    expect(promotionFor('8/P6K/8/8/8/8/8/k7 w - - 0 1', 'h7', 'h8')).toBeNull()
    // A pawn move that does not reach the last rank.
    expect(promotionFor('8/8/P7/8/8/8/8/k6K w - - 0 1', 'a6', 'a7')).toBeNull()
    // A blocked pawn: the square ahead is taken.
    expect(promotionFor('n7/P7/8/8/8/8/8/k6K w - - 0 1', 'a7', 'a8')).toBeNull()
    // A capture that is not there.
    expect(promotionFor(PAWN_ON_A7, 'a7', 'b8')).toBeNull()
  })
})

describe('PromotionChooser', () => {
  const pending = { from: 'a7', to: 'a8', color: 'w' } as const

  it('offers four named pieces in a dialog and reports the one pressed', () => {
    const onChoose = vi.fn()
    render(
      <PromotionChooser
        onCancel={() => undefined}
        onChoose={onChoose}
        orientation="white"
        pending={pending}
      />,
    )

    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
    for (const name of ['queen', 'rook', 'bishop', 'knight']) {
      expect(screen.getByRole('button', { name: `Promote to ${name}` })).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Promote to knight' }))
    expect(onChoose).toHaveBeenCalledWith('n')
  })

  it('starts on the queen and cancels on Escape or a press outside', () => {
    const onCancel = vi.fn()
    render(
      <PromotionChooser
        onCancel={onCancel}
        onChoose={() => undefined}
        orientation="white"
        pending={pending}
      />,
    )

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Promote to queen' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel promotion' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('stands on the promotion square whichever way the board faces', () => {
    const { container, rerender } = render(
      <PromotionChooser
        onCancel={() => undefined}
        onChoose={() => undefined}
        orientation="white"
        pending={{ from: 'c7', to: 'c8', color: 'w' }}
      />,
    )
    const column = () => container.querySelector<HTMLElement>('.promo-choice__options')!
    // White at the bottom: c8 is the third file from the left, on the top edge.
    expect(column().style.left).toBe('25%')
    expect(column().dataset.edge).toBe('top')

    rerender(
      <PromotionChooser
        onCancel={() => undefined}
        onChoose={() => undefined}
        orientation="black"
        pending={{ from: 'c7', to: 'c8', color: 'w' }}
      />,
    )
    // Flipped: the c-file is the sixth from the left and rank 8 is at the bottom.
    expect(column().style.left).toBe('62.5%')
    expect(column().dataset.edge).toBe('bottom')
  })
})
