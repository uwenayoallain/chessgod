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
