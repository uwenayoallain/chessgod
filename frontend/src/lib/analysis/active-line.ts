import { STARTING_FEN, type MoveNode, type ReplayMove } from '@/store/app-store'

export type ActiveReplayLine = {
  nodeIds: string[]
  replayMoves: ReplayMove[]
  fenHistory: string[]
}

export function buildActiveReplayLine(nodes: Record<string, MoveNode>, currentNodeId: string): ActiveReplayLine {
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
