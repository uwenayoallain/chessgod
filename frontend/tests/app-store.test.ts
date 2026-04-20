import { afterEach, describe, expect, test } from 'vitest'

import { STARTING_FEN, useAppStore } from '../src/store/app-store'

function resetStore() {
  useAppStore.getState().loadReplay([])
  useAppStore.setState({
    username: null,
    boardOrientation: 'white',
    keepUserOnBottom: false,
    colorFilter: 'both',
    timeClassFilter: null,
    importStatus: 'idle',
    importProgress: null,
  })
}

afterEach(resetStore)

describe('useAppStore history', () => {
  test('pushPosition appends and reuses existing children', () => {
    const { pushPosition, goBack } = useAppStore.getState()

    pushPosition('fen-a')
    pushPosition('fen-b')
    goBack()
    useAppStore.getState().pushPosition('fen-c')

    const state = useAppStore.getState()
    expect(state.fenHistory).toEqual([STARTING_FEN, 'fen-a', 'fen-c'])
    expect(state.currentFen).toBe('fen-c')
  })

  test('resetToStart clears navigation state', () => {
    const { pushPosition, resetToStart } = useAppStore.getState()

    pushPosition('fen-a')
    resetToStart()

    expect(useAppStore.getState().historyIndex).toBe(0)
    expect(useAppStore.getState().currentFen).toBe(STARTING_FEN)
  })

  test('loadReplay hydrates move and fen history from the start position', () => {
    useAppStore.getState().loadReplay([
      { ply: 1, san: 'e4', uci: 'e2e4', fen: 'fen-e4' },
      { ply: 2, san: 'e5', uci: 'e7e5', fen: 'fen-e5' },
    ])

    const state = useAppStore.getState()
    expect(state.fenHistory).toEqual([STARTING_FEN])
    expect(state.replayMoves).toEqual([
      { ply: 1, san: 'e4', uci: 'e2e4', fen: 'fen-e4' },
      { ply: 2, san: 'e5', uci: 'e7e5', fen: 'fen-e5' },
    ])
    expect(state.historyIndex).toBe(0)
    expect(state.currentFen).toBe(STARTING_FEN)
  })

  test('clearLoadedLine returns the board to free-play state', () => {
    useAppStore.getState().loadReplay([
      { ply: 1, san: 'e4', uci: 'e2e4', fen: 'fen-e4' },
      { ply: 2, san: 'e5', uci: 'e7e5', fen: 'fen-e5' },
    ])
    useAppStore.getState().setBookPlies([1, 2])

    useAppStore.getState().clearLoadedLine()

    const state = useAppStore.getState()
    expect(state.currentFen).toBe(STARTING_FEN)
    expect(state.mainLine).toEqual([])
    expect(state.replayMoves).toEqual([])
    expect(state.bookPlies).toEqual([])
    expect(state.hasLoadedLine).toBe(false)
  })

  test('preserves the loaded game line when creating a branch', () => {
    useAppStore.getState().loadReplay([
      { ply: 1, san: 'e4', uci: 'e2e4', fen: 'fen-e4' },
      { ply: 2, san: 'e5', uci: 'e7e5', fen: 'fen-e5' },
      { ply: 3, san: 'Nf3', uci: 'g1f3', fen: 'fen-nf3' },
    ], 2)

    useAppStore.getState().pushPosition('fen-alt', 'Bc4', 'f1c4')

    expect(useAppStore.getState().replayMoves).toEqual([
      { ply: 1, san: 'e4', uci: 'e2e4', fen: 'fen-e4' },
      { ply: 2, san: 'e5', uci: 'e7e5', fen: 'fen-e5' },
      { ply: 3, san: 'Nf3', uci: 'g1f3', fen: 'fen-nf3' },
    ])
    expect(useAppStore.getState().currentFen).toBe('fen-alt')

    useAppStore.getState().jumpToIndex(3)
    expect(useAppStore.getState().currentFen).toBe('fen-nf3')
  })

  test('stores keepUserOnBottom preference and aligns board to user color', () => {
    const { setKeepUserOnBottom, alignBoardToUserColor } = useAppStore.getState()

    setKeepUserOnBottom(true)
    alignBoardToUserColor('black')

    expect(useAppStore.getState().keepUserOnBottom).toBe(true)
    expect(useAppStore.getState().boardOrientation).toBe('black')

    alignBoardToUserColor('white')
    expect(useAppStore.getState().boardOrientation).toBe('white')
  })

  test('alignBoardToUserColor defaults to white for unknown values', () => {
    useAppStore.getState().alignBoardToUserColor('something-else')

    expect(useAppStore.getState().boardOrientation).toBe('white')
  })
})
