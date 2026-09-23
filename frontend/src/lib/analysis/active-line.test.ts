import { describe, expect, it } from 'vite-plus/test'

import { STARTING_FEN, type MoveNode } from '@/store/app-store'
import { buildActiveReplayLine, buildFullGameLine } from './active-line'

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
      n1: createNode({
        id: 'n1',
        fen: 'fen-e4',
        ply: 1,
        parentId: 'root',
        san: 'e4',
        uci: 'e2e4',
        children: ['n2', 's2'],
      }),
      n2: createNode({
        id: 'n2',
        fen: 'fen-e5',
        ply: 2,
        parentId: 'n1',
        san: 'e5',
        uci: 'e7e5',
        children: ['n3'],
      }),
      n3: createNode({
        id: 'n3',
        fen: 'fen-nf3',
        ply: 3,
        parentId: 'n2',
        san: 'Nf3',
        uci: 'g1f3',
        children: [],
      }),
      s2: createNode({
        id: 's2',
        fen: 'fen-c5',
        ply: 2,
        parentId: 'n1',
        san: 'c5',
        uci: 'c7c5',
        children: [],
      }),
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

describe('buildFullGameLine', () => {
  // root → e4 → e5 → Nf3, with the cursor parked on e4.
  const nodes = {
    root: {
      id: 'root',
      parentId: null,
      children: ['a'],
      fen: 'fen0',
      ply: 0,
      san: null,
      uci: null,
    },
    a: { id: 'a', parentId: 'root', children: ['b'], fen: 'fen1', ply: 1, san: 'e4', uci: 'e2e4' },
    b: { id: 'b', parentId: 'a', children: ['c'], fen: 'fen2', ply: 2, san: 'e5', uci: 'e7e5' },
    c: { id: 'c', parentId: 'b', children: [], fen: 'fen3', ply: 3, san: 'Nf3', uci: 'g1f3' },
  } as unknown as Parameters<typeof buildFullGameLine>[0]

  it('covers the whole game from a cursor part-way through', () => {
    const line = buildFullGameLine(nodes, 'a')
    expect(line.fenHistory).toEqual(['fen0', 'fen1', 'fen2', 'fen3'])
    expect(line.replayMoves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3'])
  })

  it('reaches the whole game from the starting position', () => {
    // This is the case that matters: a freshly loaded game sits at the root.
    const line = buildFullGameLine(nodes, 'root')
    expect(line.fenHistory).toHaveLength(4)
    expect(line.replayMoves).toHaveLength(3)
  })

  it('matches the active line when already at the end', () => {
    expect(buildFullGameLine(nodes, 'c')).toEqual(buildActiveReplayLine(nodes, 'c'))
  })

  it('falls back to the active line for an unknown node', () => {
    expect(buildFullGameLine(nodes, 'nope')).toEqual(buildActiveReplayLine(nodes, 'nope'))
  })

  it('stops instead of looping if the graph cycles', () => {
    const cyclic = {
      root: {
        id: 'root',
        parentId: null,
        children: ['a'],
        fen: 'f0',
        ply: 0,
        san: null,
        uci: null,
      },
      a: { id: 'a', parentId: 'root', children: ['a'], fen: 'f1', ply: 1, san: 'e4', uci: 'e2e4' },
    } as unknown as Parameters<typeof buildFullGameLine>[0]
    expect(buildFullGameLine(cyclic, 'root').fenHistory).toEqual(['f0', 'f1'])
  })
})
