import { describe, expect, it } from 'vite-plus/test'

import { STARTING_FEN, type MoveNode } from '@/store/app-store'
import { buildActiveReplayLine, buildFullGameLine, mainLineLeafId } from './active-line'

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

  it('returns one line object for every cursor position inside a game', () => {
    // Stepping through a game must not rebuild its line: everything a review
    // derives from it (the graph, the summary, the retry list) is keyed on it.
    const fromRoot = buildFullGameLine(nodes, 'root')
    expect(buildFullGameLine(nodes, 'a')).toBe(fromRoot)
    expect(buildFullGameLine(nodes, 'b')).toBe(fromRoot)
    expect(buildFullGameLine(nodes, 'c')).toBe(fromRoot)
  })

  it('builds a new line when the tree is replaced', () => {
    const before = buildFullGameLine(nodes, 'root')
    const grown = {
      ...nodes,
      c: { ...nodes.c, children: ['d'] },
      d: { id: 'd', parentId: 'c', children: [], fen: 'fen4', ply: 4, san: 'Nc6', uci: 'b8c6' },
    } as unknown as Parameters<typeof buildFullGameLine>[0]
    const after = buildFullGameLine(grown, 'root')
    expect(after).not.toBe(before)
    expect(after.replayMoves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6'])
  })
})

describe('mainLineLeafId', () => {
  const nodes = {
    root: { id: 'root', parentId: null, children: ['a'], fen: 'f0', ply: 0, san: null, uci: null },
    a: {
      id: 'a',
      parentId: 'root',
      children: ['b', 's'],
      fen: 'f1',
      ply: 1,
      san: 'e4',
      uci: 'e2e4',
    },
    b: { id: 'b', parentId: 'a', children: [], fen: 'f2', ply: 2, san: 'e5', uci: 'e7e5' },
    s: { id: 's', parentId: 'a', children: ['t'], fen: 'f3', ply: 2, san: 'c5', uci: 'c7c5' },
    t: { id: 't', parentId: 's', children: [], fen: 'f4', ply: 3, san: 'Nf3', uci: 'g1f3' },
  } as unknown as Parameters<typeof mainLineLeafId>[0]

  it('is the same for every position on the main line', () => {
    expect(mainLineLeafId(nodes, 'root')).toBe('b')
    expect(mainLineLeafId(nodes, 'a')).toBe('b')
    expect(mainLineLeafId(nodes, 'b')).toBe('b')
  })

  it('follows a side line to its own end once the cursor is on it', () => {
    expect(mainLineLeafId(nodes, 's')).toBe('t')
    expect(mainLineLeafId(nodes, 't')).toBe('t')
  })

  it('returns the id it was given for a node that does not exist', () => {
    expect(mainLineLeafId(nodes, 'missing')).toBe('missing')
  })
})

describe('a long line', () => {
  it('is walked root first without losing order', () => {
    const nodes: Record<string, MoveNode> = {
      root: createNode({ id: 'root', fen: 'f0', ply: 0, children: ['n1'] }),
    }
    const plies = 400
    for (let ply = 1; ply <= plies; ply += 1) {
      nodes[`n${ply}`] = createNode({
        id: `n${ply}`,
        fen: `f${ply}`,
        ply,
        parentId: ply === 1 ? 'root' : `n${ply - 1}`,
        san: `m${ply}`,
        uci: 'a1a2',
        children: ply < plies ? [`n${ply + 1}`] : [],
      })
    }
    const line = buildActiveReplayLine(nodes, `n${plies}`)
    expect(line.fenHistory).toHaveLength(plies + 1)
    expect(line.fenHistory[0]).toBe('f0')
    expect(line.fenHistory[plies]).toBe(`f${plies}`)
    expect(line.replayMoves.map((move) => move.ply)).toEqual(
      Array.from({ length: plies }, (_, index) => index + 1),
    )
  })
})
