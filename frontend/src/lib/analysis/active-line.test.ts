import { describe, expect, it } from 'vitest'

import { STARTING_FEN, type MoveNode } from '@/store/app-store'
import { buildActiveReplayLine } from './active-line'

function createNode(partial: Partial<MoveNode> & Pick<MoveNode, 'id' | 'fen' | 'ply'>): MoveNode {
  return {
    children: partial.children ?? [],
    parentId: partial.parentId ?? null,
    san: partial.san ?? null,
    uci: partial.uci ?? null,
    ...partial,
  }
}

describe('buildActiveReplayLine', () => {
  it('returns the active path from root to current node', () => {
    const nodes: Record<string, MoveNode> = {
      root: createNode({ id: 'root', fen: STARTING_FEN, ply: 0, children: ['n1'] }),
      n1: createNode({ id: 'n1', fen: 'fen-e4', ply: 1, parentId: 'root', san: 'e4', uci: 'e2e4', children: ['n2', 's2'] }),
      n2: createNode({ id: 'n2', fen: 'fen-e5', ply: 2, parentId: 'n1', san: 'e5', uci: 'e7e5', children: ['n3'] }),
      n3: createNode({ id: 'n3', fen: 'fen-nf3', ply: 3, parentId: 'n2', san: 'Nf3', uci: 'g1f3', children: [] }),
      s2: createNode({ id: 's2', fen: 'fen-c5', ply: 2, parentId: 'n1', san: 'c5', uci: 'c7c5', children: [] }),
    }

    const activeLine = buildActiveReplayLine(nodes, 'n3')

    expect(activeLine.nodeIds).toEqual(['n1', 'n2', 'n3'])
    expect(activeLine.fenHistory).toEqual([STARTING_FEN, 'fen-e4', 'fen-e5', 'fen-nf3'])
    expect(activeLine.replayMoves).toEqual([
      { ply: 1, san: 'e4', uci: 'e2e4', fen: 'fen-e4' },
      { ply: 2, san: 'e5', uci: 'e7e5', fen: 'fen-e5' },
      { ply: 3, san: 'Nf3', uci: 'g1f3', fen: 'fen-nf3' },
    ])
  })

  it('returns defaults for unknown current node', () => {
    const activeLine = buildActiveReplayLine({}, 'missing')

    expect(activeLine.nodeIds).toEqual([])
    expect(activeLine.replayMoves).toEqual([])
    expect(activeLine.fenHistory).toEqual([STARTING_FEN])
  })
})
