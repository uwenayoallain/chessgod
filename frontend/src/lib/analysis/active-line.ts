import { STARTING_FEN, type MoveNode, type ReplayMove } from '@/store/app-store'

export type ActiveReplayLine = {
  nodeIds: string[]
  replayMoves: ReplayMove[]
  fenHistory: string[]
}

/**
 * Lines already built for a tree. The tree is replaced, never edited in place,
 * so the `nodes` object identifies it; every hook asking for the same line of
 * the same tree gets the same object back, which is what lets the annotation
 * cache (keyed on `replayMoves`) grade a line once however many components
 * read it. Only the last few lines per tree are kept: stepping through a long
 * game would otherwise hold one copy of the game per move.
 */
const LINES_KEPT = 4
const lineCache = new WeakMap<Record<string, MoveNode>, Map<string, ActiveReplayLine>>()

function cachedLine(
  nodes: Record<string, MoveNode>,
  nodeId: string,
  build: () => ActiveReplayLine,
): ActiveReplayLine {
  let lines = lineCache.get(nodes)
  if (!lines) {
    lines = new Map()
    lineCache.set(nodes, lines)
  }
  const hit = lines.get(nodeId)
  if (hit) return hit
  const line = build()
  if (lines.size >= LINES_KEPT) {
    const oldest = lines.keys().next().value
    if (oldest !== undefined) lines.delete(oldest)
  }
  lines.set(nodeId, line)
  return line
}

/** The returned line is shared between callers and must not be mutated. */
export function buildActiveReplayLine(
  nodes: Record<string, MoveNode>,
  currentNodeId: string,
): ActiveReplayLine {
  return cachedLine(nodes, currentNodeId, () => walkToRoot(nodes, currentNodeId))
}

function walkToRoot(nodes: Record<string, MoveNode>, currentNodeId: string): ActiveReplayLine {
  const path: MoveNode[] = []
  let cursor: MoveNode | undefined = nodes[currentNodeId]

  // Collected leaf first and reversed once: `unshift` moves the whole array on
  // every node, which is quadratic over a long game.
  while (cursor) {
    path.push(cursor)
    cursor = cursor.parentId ? nodes[cursor.parentId] : undefined
  }
  path.reverse()

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
 * The last node of the game the cursor is in: from the current node down the
 * main line (each node's first child) to its end. Every position of a loaded
 * game shares one leaf, so a value keyed on it survives stepping through the
 * game, and only changes when the cursor leaves for another line or the line
 * itself grows.
 */
export function mainLineLeafId(nodes: Record<string, MoveNode>, currentNodeId: string): string {
  let cursor: MoveNode | undefined = nodes[currentNodeId]
  if (!cursor) return currentNodeId

  // Guard against a cycle in the node graph rather than trusting it, since
  // this walk is unbounded.
  const seen = new Set<string>([cursor.id])
  for (;;) {
    const nextId: string | undefined = cursor.children[0]
    if (!nextId || seen.has(nextId)) return cursor.id
    const next: MoveNode | undefined = nodes[nextId]
    if (!next) return cursor.id
    seen.add(nextId)
    cursor = next
  }
}

/**
 * The whole game, not just the part that has been stepped through: the path
 * from the root down to the current node, continued along the main line to its
 * end.
 *
 * `buildActiveReplayLine` stops at the cursor, which is right for "what led to
 * the position on the board" but wrong for "review this game": on loading a
 * game the cursor sits at move one, and a review scoped to the cursor would
 * cover a single move.
 *
 * It is the path from the root to the main line's leaf, so every cursor
 * position inside one game returns the same (shared, read-only) object.
 */
export function buildFullGameLine(
  nodes: Record<string, MoveNode>,
  currentNodeId: string,
): ActiveReplayLine {
  return buildActiveReplayLine(nodes, mainLineLeafId(nodes, currentNodeId))
}
