import { beforeEach, describe, expect, it } from 'vite-plus/test'

import { buildLatestMoveSquareStyles } from '@/lib/analysis/board-guidance'
import { useAppStore } from './app-store'

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
