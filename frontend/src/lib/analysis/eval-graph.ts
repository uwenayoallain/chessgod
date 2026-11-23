/**
 * Geometry for the evaluation graph: the shape of a game at a glance.
 *
 * Everything here is pure so the curve can be tested without a renderer. The
 * component supplies the evaluations; this decides where they sit.
 */

/** Beyond six pawns the exact number stops mattering — it is simply winning. */
export const EVAL_CLAMP_CP = 600

export type GraphPoint = {
  /** Index into the position list: 0 is the starting position. */
  index: number
  x: number
  y: number
  /** Clamped centipawns, White's perspective. */
  cp: number
}

export function clampCp(cp: number, limit: number = EVAL_CLAMP_CP): number {
  if (!Number.isFinite(cp)) return 0
  return Math.max(-limit, Math.min(limit, cp))
}

/**
 * Places each known evaluation in the box. Positions with no evaluation are
 * skipped rather than guessed at, so a partly analysed game draws only the
 * part that is real.
 */
export function layoutEvalPoints({
  evaluations,
  width,
  height,
  limit = EVAL_CLAMP_CP,
}: {
  evaluations: Array<number | null>
  width: number
  height: number
  limit?: number
}): GraphPoint[] {
  const span = Math.max(1, evaluations.length - 1)
  const midline = height / 2
  const points: GraphPoint[] = []

  evaluations.forEach((value, index) => {
    if (value == null) return
    const cp = clampCp(value, limit)
    points.push({
      index,
      cp,
      x: (index / span) * width,
      // Positive is good for White, and White belongs at the top.
      y: midline - (cp / limit) * midline,
    })
  })

  return points
}

export function buildLinePath(points: GraphPoint[]): string {
  if (!points.length) return ''
  return points
    .map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ')
}

/**
 * The line closed against one edge, so the filled region reads as "how much of
 * the game each side was winning".
 */
export function buildAreaPath(points: GraphPoint[], edgeY: number): string {
  if (!points.length) return ''
  const first = points[0]
  const last = points[points.length - 1]
  return [
    `M${first.x.toFixed(2)} ${edgeY}`,
    buildLinePath(points).slice(1),
    `L${last.x.toFixed(2)} ${edgeY}`,
    'Z',
  ].join(' ')
}

/** Where a given position sits horizontally, for the "you are here" marker. */
export function xForIndex(index: number, count: number, width: number): number {
  const span = Math.max(1, count - 1)
  return (Math.max(0, Math.min(index, span)) / span) * width
}
