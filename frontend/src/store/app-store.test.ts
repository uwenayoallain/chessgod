import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { buildLatestMoveSquareStyles } from '@/lib/analysis/board-guidance'
import { safeGetItem, safeRemoveItem, safeSetItem } from '@/lib/storage'
import { replayOfSparringGame } from '@/hooks/use-sparring'
import { STARTING_FEN, useAppStore } from './app-store'

const POSITION = '8/7p/5pp1/p2Pk3/1rK5/1P3PP1/7P/3R4 w - -'

describe('loadPosition', () => {
  beforeEach(() => {
    useAppStore.getState().loadPosition(POSITION)
  })

  it('jumps to the position with an empty line', () => {
    const state = useAppStore.getState()
    expect(state.currentFen).toBe(POSITION)
    expect(state.mainLine).toEqual([])
    expect(state.nodes[state.currentNodeId].san).toBeNull()
  })

  it('carries the move that produced the position when given one', () => {
    // A drill jumps straight to a position, so there is no parent node — the
    // move being answered has to ride on the root or the board cannot show it.
    useAppStore.getState().loadPosition(POSITION, 'b4b3')
    const state = useAppStore.getState()
    expect(state.nodes[state.currentNodeId].uci).toBe('b4b3')
  })

  it('highlights that move on the board', () => {
    useAppStore.getState().loadPosition(POSITION, 'b4b3')
    const state = useAppStore.getState()
    const styles = buildLatestMoveSquareStyles(state.nodes[state.currentNodeId].uci)
    expect(Object.keys(styles).sort()).toEqual(['b3', 'b4'])
  })

  it('still counts as no move played, so the line stays empty', () => {
    useAppStore.getState().loadPosition(POSITION, 'b4b3')
    const state = useAppStore.getState()
    expect(state.nodes[state.currentNodeId].san).toBeNull()
    expect(state.moveHistory).toEqual([])
  })

  it('carries no move when none is given', () => {
    const state = useAppStore.getState()
    expect(state.nodes[state.currentNodeId].uci).toBeNull()
    expect(buildLatestMoveSquareStyles(state.nodes[state.currentNodeId].uci)).toEqual({})
  })
})

describe('jumpToFen', () => {
  const MOVES = [
    {
      ply: 1,
      san: 'e4',
      uci: 'e2e4',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3',
    },
    {
      ply: 2,
      san: 'e5',
      uci: 'e7e5',
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6',
    },
  ]

  it('lands on the loaded line, keeping its move list', () => {
    useAppStore.getState().loadReplay(MOVES, 2)
    useAppStore.getState().jumpToFen(MOVES[0].fen)
    const state = useAppStore.getState()
    // The node is the game's own, so the SAN (and every annotation keyed to
    // it) survives — a pushed branch here used to blank the move list.
    expect(state.nodes[state.currentNodeId].san).toBe('e4')
    expect(state.mainLine).toHaveLength(2)
  })

  it('matches a position whatever its move counters say', () => {
    useAppStore.getState().loadReplay(MOVES, 2)
    useAppStore.getState().jumpToFen(`${MOVES[0].fen} 0 1`)
    expect(useAppStore.getState().nodes[useAppStore.getState().currentNodeId].san).toBe('e4')
  })

  it('falls back to a branch for a position outside the line', () => {
    useAppStore.getState().loadReplay(MOVES, 2)
    useAppStore.getState().jumpToFen(POSITION)
    expect(useAppStore.getState().currentFen).toBe(POSITION)
  })
})

describe('position-scoped trainer arrows', () => {
  it('records which position the arrows belong to', () => {
    const arrows = [{ startSquare: 'e2', endSquare: 'e4', color: 'red' }]
    useAppStore.getState().setTrainerArrows(arrows, POSITION)
    expect(useAppStore.getState().trainerArrowsFen).toBe(POSITION)
    // A trainer's unscoped arrows clear the scope, as before.
    useAppStore.getState().setTrainerArrows([])
    expect(useAppStore.getState().trainerArrowsFen).toBeNull()
  })
})

describe('scoped arrows die with the tree they were drawn for', () => {
  it('clears browse arrows on a wholesale load, but leaves trainer arrows alone', () => {
    const arrows = [{ startSquare: 'e2', endSquare: 'e4', color: 'red' }]
    // Browse arrows (scoped): any new tree invalidates them — this is what
    // stops a mistake row's answer arrows surviving into a drill or a game
    // that lands on the same position.
    useAppStore.getState().setTrainerArrows(arrows, POSITION)
    useAppStore.getState().loadPosition(POSITION)
    expect(useAppStore.getState().trainerArrows).toEqual([])
    expect(useAppStore.getState().trainerArrowsFen).toBeNull()

    // Trainer arrows (unscoped) are the trainer's own to manage: a trainer
    // loads its question first and draws after, so loading must not wipe what
    // another part of the trainer just drew.
    useAppStore.getState().setTrainerArrows(arrows)
    useAppStore.getState().loadPosition(POSITION)
    expect(useAppStore.getState().trainerArrows).toEqual(arrows)
  })
})

describe('stepping through a loaded game', () => {
  const GAME = [
    {
      ply: 1,
      san: 'e4',
      uci: 'e2e4',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -',
    },
    {
      ply: 2,
      san: 'e5',
      uci: 'e7e5',
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -',
    },
    {
      ply: 3,
      san: 'Nf3',
      uci: 'g1f3',
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -',
    },
  ]

  it('keeps one main-line move list while the cursor moves', () => {
    // The list depends on the tree and the main line, not on where the cursor
    // is. Rebuilt per step it re-rendered every subscriber on every step.
    useAppStore.getState().loadReplay(GAME)
    const loaded = useAppStore.getState().replayMoves
    expect(loaded.map((move) => move.san)).toEqual(['e4', 'e5', 'Nf3'])

    useAppStore.getState().goForward()
    expect(useAppStore.getState().replayMoves).toBe(loaded)
    useAppStore.getState().jumpToIndex(3)
    expect(useAppStore.getState().replayMoves).toBe(loaded)
    useAppStore.getState().goBack()
    expect(useAppStore.getState().replayMoves).toBe(loaded)
    useAppStore.getState().resetToStart()
    expect(useAppStore.getState().replayMoves).toBe(loaded)
  })

  it('follows the cursor in the path it reports, root first', () => {
    useAppStore.getState().loadReplay(GAME)
    useAppStore.getState().jumpToIndex(2)
    const state = useAppStore.getState()
    expect(state.moveHistory).toEqual(['e4', 'e5'])
    expect(state.fenHistory).toHaveLength(3)
    expect(state.fenHistory[2]).toBe(GAME[1].fen)
    expect(state.historyIndex).toBe(2)
    expect(state.getCurrentPath().map((node) => node.san)).toEqual([null, 'e4', 'e5'])
  })

  it('builds a new list when another game replaces the line', () => {
    useAppStore.getState().loadReplay(GAME)
    const first = useAppStore.getState().replayMoves
    useAppStore.getState().loadReplay(GAME.slice(0, 2))
    const second = useAppStore.getState().replayMoves
    expect(second).not.toBe(first)
    expect(second).toHaveLength(2)
  })

  it('hands out a list of its own from the getter', () => {
    useAppStore.getState().loadReplay(GAME)
    const shared = useAppStore.getState().replayMoves
    const own = useAppStore.getState().getMainLineMoves()
    expect(own).toEqual(shared)
    expect(own).not.toBe(shared)
  })
})

describe('storage that refuses', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads as empty and reports the failed write when the accessor throws', () => {
    // With site data blocked the `localStorage` getter itself throws. Uncaught
    // in a store or provider initialiser, that blanks the app.
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    })
    expect(safeGetItem('chessgod.username')).toBeNull()
    expect(safeSetItem('chessgod.username', 'someone')).toBe(false)
    expect(safeRemoveItem('chessgod.username')).toBe(false)
  })

  it('reads as empty when a method throws (a full or disabled store)', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem() {
          throw new Error('disabled')
        },
        setItem() {
          throw new DOMException('quota', 'QuotaExceededError')
        },
        removeItem() {
          throw new Error('disabled')
        },
      },
    })
    expect(safeGetItem('any')).toBeNull()
    expect(safeSetItem('any', 'value')).toBe(false)
    expect(safeRemoveItem('any')).toBe(false)
  })

  it('stores and reads back when storage works', () => {
    const held = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => held.get(key) ?? null,
        setItem: (key: string, value: string) => void held.set(key, value),
        removeItem: (key: string) => void held.delete(key),
      },
    })
    expect(safeSetItem('chessgod.timeClass', 'blitz')).toBe(true)
    expect(safeGetItem('chessgod.timeClass')).toBe('blitz')
    expect(safeRemoveItem('chessgod.timeClass')).toBe(true)
    expect(safeGetItem('chessgod.timeClass')).toBeNull()
  })

  it('lets the store remember a preference without throwing', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    })
    expect(() => useAppStore.getState().setUsername('someone')).not.toThrow()
    expect(useAppStore.getState().username).toBe('someone')
    expect(() => useAppStore.getState().setTimeClassFilter(null)).not.toThrow()
    expect(() => useAppStore.getState().setKeepUserOnBottom(true)).not.toThrow()
    expect(() => useAppStore.getState().clearUsername()).not.toThrow()
    expect(useAppStore.getState().username).toBeNull()
  })
})

describe('a replay that does not start at move one', () => {
  // A drill played out against the engine: Black to move after 1.e4 e5 2.Nf3.
  const START = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -'
  const SAVED_MOVES = ['b8c6', 'f1c4']

  it('roots the line at the position the game started from', () => {
    // The saved game carries full FENs; positions are keyed on four fields.
    const moves = replayOfSparringGame(`${START} 1 2`, SAVED_MOVES)
    useAppStore.getState().loadReplay(moves, 0, 'loaded', `${START} 1 2`)
    const state = useAppStore.getState()
    // Rooted at the standard start, the board showed the initial position
    // under a line that cannot be played from it.
    expect(state.currentFen).toBe(START)
    expect(state.nodes[state.currentNodeId].fen).toBe(START)
    expect(state.fenHistory[0]).toBe(START)
    expect(state.replayMoves.map((move) => move.san)).toEqual(['Nc6', 'Bc4'])
    expect(state.hasLoadedLine).toBe(true)

    useAppStore.getState().goForward()
    expect(useAppStore.getState().currentFen).toBe(moves[0].fen)
    useAppStore.getState().resetToStart()
    expect(useAppStore.getState().currentFen).toBe(START)
  })

  it('replays a saved game into the four-field positions live play uses', () => {
    const moves = replayOfSparringGame(`${START} 1 2`, SAVED_MOVES)
    expect(moves.map((move) => move.fen)).toEqual([
      'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -',
      'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq -',
    ])
    // The same game from a start FEN that already dropped its counters.
    expect(replayOfSparringGame(START, SAVED_MOVES)).toEqual(moves)
  })

  it('still starts an ordinary game at the standard position', () => {
    useAppStore.getState().loadReplay(replayOfSparringGame(STARTING_FEN, ['e2e4']))
    const state = useAppStore.getState()
    expect(state.currentFen).toBe(STARTING_FEN)
    expect(state.replayMoves.map((move) => move.san)).toEqual(['e4'])
  })
})
