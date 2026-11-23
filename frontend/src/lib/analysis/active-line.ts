import { STARTING_FEN, type MoveNode, type ReplayMove } from '@/store/app-store'

export type ActiveReplayLine = {
  nodeIds: string[]
  replayMoves: ReplayMove[]
  fenHistory: string[]
}

export function buildActiveReplayLine(
  nodes: Record<string, MoveNode>,
  currentNodeId: string,
): ActiveReplayLine {
  const path: MoveNode[] = []
  let cursor: MoveNode | undefined = nodes[currentNodeId]

  while (cursor) {
    path.unshift(cursor)
    cursor = cursor.parentId ? nodes[cursor.parentId] : undefined
  }

  if (!path.length) {
    return {
      fenHistory: [STARTING_FEN],
      nodeIds: [],
      replayMoves: [],
    }
  }

  const replayNodes = path.filter((node) => Boolean(node.san))

  return {
    fenHistory: path.map((node) => node.fen),
    nodeIds: replayNodes.map((node) => node.id),
    replayMoves: replayNodes.map((node) => ({
      ply: node.ply,
      san: node.san ?? '',
      uci: node.uci ?? '',
      fen: node.fen,
    })),
  }
}

/**
 * The whole game, not just the part that has been stepped through: the path
 * from the root down to the current node, continued along the main line to its
 * end.
 *
 * `buildActiveReplayLine` stops at the cursor, which is right for "what led to
 * the position on the board" but wrong for "review this game" — on loading a
 * game the cursor sits at move one, and a review scoped to the cursor would
 * cover a single move.
 */
export function buildFullGameLine(
  nodes: Record<string, MoveNode>,
  currentNodeId: string,
): ActiveReplayLine {
  const active = buildActiveReplayLine(nodes, currentNodeId)
  if (!nodes[currentNodeId]) return active

  const path: MoveNode[] = []
  let cursor: MoveNode | undefined = nodes[currentNodeId]

  // Continue down the main line. Guard against a cycle in the node graph
  // rather than trusting it, since this walk is unbounded.
  const seen = new Set<string>([currentNodeId])
  while (cursor) {
    const nextId: string | undefined = cursor.children[0]
    if (!nextId || seen.has(nextId)) break
    seen.add(nextId)
    cursor = nodes[nextId]
    if (!cursor) break
    path.push(cursor)
  }

  if (!path.length) return active

  const continuation = path.filter((node) => Boolean(node.san))

  return {
    fenHistory: [...active.fenHistory, ...path.map((node) => node.fen)],
    nodeIds: [...active.nodeIds, ...continuation.map((node) => node.id)],
    replayMoves: [
      ...active.replayMoves,
      ...continuation.map((node) => ({
        ply: node.ply,
        san: node.san ?? '',
        uci: node.uci ?? '',
        fen: node.fen,
      })),
    ],
  }
}
