import { afterEach, describe, expect, test } from 'vite-plus/test'

import { STARTING_FEN, useAppStore } from '../src/store/app-store'

function resetStore() {
  useAppStore.getState().loadReplay([])
  useAppStore.setState({
    username: null,
    boardOrientation: 'white',
    keepUserOnBottom: false,
    colorFilter: 'both',
    timeClassFilter: 'rapid_blitz',
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

  test('loadPosition makes a drill position the navigation root', () => {
    useAppStore.getState().loadPosition('training-fen')
    useAppStore.getState().pushPosition('after-answer', 'e4', 'e2e4')
    useAppStore.getState().goBack()

    const state = useAppStore.getState()
    expect(state.currentFen).toBe('training-fen')
    expect(state.fenHistory).toEqual(['training-fen'])
    expect(state.replayMoves).toEqual([])
  })

  test('preserves the loaded game line when creating a branch', () => {
    useAppStore.getState().loadReplay(
      [
        { ply: 1, san: 'e4', uci: 'e2e4', fen: 'fen-e4' },
        { ply: 2, san: 'e5', uci: 'e7e5', fen: 'fen-e5' },
        { ply: 3, san: 'Nf3', uci: 'g1f3', fen: 'fen-nf3' },
      ],
      2,
    )

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

  test('clearUsername removes the active player and import state', () => {
    const { clearUsername, setUsername, setImportProgress, setImportStatus } =
      useAppStore.getState()

    setUsername('hikaru')
    setImportStatus('complete')
    setImportProgress({
      archiveIndex: 1,
      archiveNewGames: 2,
      archiveSkippedGames: 3,
      cached: false,
      cachedArchives: 0,
      complete: true,
      currentArchive: '2026-01',
      currentGameIndex: 4,
      currentGameLabel: 'Game 4',
      gamesInArchive: 10,
      newGames: 2,
      skippedGames: 3,
      totalArchives: 1,
    })

    clearUsername()

    expect(useAppStore.getState().username).toBeNull()
    expect(useAppStore.getState().importStatus).toBe('idle')
    expect(useAppStore.getState().importProgress).toBeNull()
  })
})
