import type { ReplayMoveAnnotation } from '@/lib/analysis/replay-annotations'
import { sideToMove, type SparColor } from '@/lib/sparring/sparring'
import { scoreToWhitePerspective } from '@/lib/stockfish/eval'
import type { UCIInfo } from '@/lib/stockfish/uci'

type CachedAnalysis = { lines: UCIInfo[] }

export type SparringMistakePayload = {
  fen: string
  ply: number
  user_move_uci: string
  user_move_san: string
  best_move_uci: string
  best_pv_uci: string | null
  reply_pv_uci: string | null
  previous_move_uci: string | null
  parent_eval_cp: number
  parent_eval_mate: number | null
  eval_drop_cp: number
  /** The review's depth for the position; its line is stored as the drill's evidence. */
  depth: number
}

const DRILLED: ReadonlySet<string> = new Set(['Mistake', 'Blunder', 'Missed Win'])

function topLine(analysis: CachedAnalysis | undefined) {
  return analysis?.lines.find((line) => line.multipv === 1 && line.depth >= 18) ?? null
}

/**
 * The player's own graded mistakes from a reviewed game, in the shape the
 * drill pipeline stores. Only moves the review called a mistake or worse, and
 * only where the review has the line that refutes it.
 */
export function collectSparringMistakes({
  annotations,
  analysisByFen,
  fenHistory,
  userColor,
}: {
  annotations: ReplayMoveAnnotation[]
  analysisByFen: Record<string, CachedAnalysis>
  fenHistory: string[]
  userColor: SparColor
}): SparringMistakePayload[] {
  const out: SparringMistakePayload[] = []
  for (const [index, annotation] of annotations.entries()) {
    if (!annotation.label || !DRILLED.has(annotation.label)) continue
    const parentFen = fenHistory[annotation.ply - 1]
    // Whose move it was comes from the board, not the ply's parity: a game
    // played out from a set-up position can start with Black to move.
    if (!parentFen || sideToMove(parentFen) !== userColor) continue
    const parent = topLine(analysisByFen[parentFen])
    if (!parent?.pv[0] || annotation.cpLoss == null) continue
    const child = topLine(analysisByFen[annotation.fen])
    const white = scoreToWhitePerspective(parent.score, parentFen)
    out.push({
      fen: parentFen,
      ply: annotation.ply,
      user_move_uci: annotation.uci,
      user_move_san: annotation.san,
      best_move_uci: parent.pv[0],
      best_pv_uci: parent.pv.join(' '),
      reply_pv_uci: child?.pv.join(' ') || null,
      previous_move_uci: index > 0 ? annotations[index - 1].uci || null : null,
      parent_eval_cp:
        white.type === 'mate'
          ? white.value > 0
            ? 2000 - Math.min(20, white.value) * 10
            : -2000 + Math.min(20, -white.value) * 10
          : Math.max(-2000, Math.min(2000, white.value)),
      parent_eval_mate: white.type === 'mate' ? white.value : null,
      eval_drop_cp: Math.min(4000, Math.round(annotation.cpLoss)),
      depth: parent.depth,
    })
  }
  return out
}
