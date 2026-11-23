import type { ReplayMoveAnnotation } from '@/lib/analysis/replay-annotations'
import { scoreToWhitePerspective } from '@/lib/stockfish/eval'
import type { UCIInfo } from '@/lib/stockfish/uci'

export type MoveExplanationRequest = {
  fen: string
  ply: number
  user_move_uci: string
  best_move_uci: string
  best_pv_uci: string | null
  reply_pv_uci: string | null
  parent_eval_cp: number
  best_eval_mate: number | null
  eval_drop_cp: number
}

export type MoveExplanation = {
  ply: number
  key: string
  label: string
  detail: string | null
  cue: string
}

function topLine(analysis: { lines: UCIInfo[] } | undefined) {
  return analysis?.lines.find((line) => line.multipv === 1 && line.pv.length > 0) ?? null
}

/**
 * What the server needs to name a graded move: the position it was played
 * from, the engine's line there and its line after the move. A move whose
 * lines are not in the cache yet is left out, and asked about once they are.
 */
export function explanationRequests({
  moves,
  analysisByFen,
  fenHistory,
}: {
  moves: ReplayMoveAnnotation[]
  analysisByFen: Record<string, { lines: UCIInfo[] }>
  fenHistory: string[]
}): MoveExplanationRequest[] {
  const out: MoveExplanationRequest[] = []
  for (const move of moves) {
    const parentFen = fenHistory[move.ply - 1]
    const parent = parentFen ? topLine(analysisByFen[parentFen]) : null
    if (!parentFen || !parent || move.cpLoss == null || !move.uci) continue
    const child = topLine(analysisByFen[move.fen])
    const white = scoreToWhitePerspective(parent.score, parentFen)
    out.push({
      fen: parentFen,
      ply: move.ply,
      user_move_uci: move.uci,
      best_move_uci: parent.pv[0],
      best_pv_uci: parent.pv.join(' '),
      reply_pv_uci: child ? child.pv.join(' ') : null,
      parent_eval_cp:
        white.type === 'mate'
          ? Math.sign(white.value) * (2000 - Math.min(20, Math.abs(white.value)) * 10)
          : Math.max(-2000, Math.min(2000, white.value)),
      best_eval_mate: white.type === 'mate' ? white.value : null,
      eval_drop_cp: Math.min(4000, Math.max(0, Math.round(move.cpLoss))),
    })
  }
  return out
}
