import { reviewSide } from './game-review'
import type { ReplayMoveAnnotation } from './replay-annotations'
import type { EngineScore } from '@/lib/stockfish/uci'

/** One of the player's own moves from the game, to be tried again. */
export type RetryItem = {
  ply: number
  san: string
  uci: string
  label: string
  cpLoss: number | null
  /** The position the move was played from, and the move that led there. */
  fenBefore: string
  lastUci: string | null
  /** The node on the board that position is, so attempts branch off the game. */
  parentNodeId: string
  bestUci: string | null
}

export type RetryVerdict = 'best' | 'good' | 'same' | 'worse'

// Most a retry takes: a long game's worst few, not a second review of it.
export const MAX_RETRIES = 8
const RETRIED = new Set(['Mistake', 'Blunder', 'Missed Win'])
// An alternative this close to the engine's move, in winning chances, is as good.
export const GOOD_ENOUGH = 0.05

/**
 * The player's mistakes in the game, in the order they happened. `nodeIds`
 * are the game line's nodes after each ply, so ply p was played from
 * `nodeIds[p - 2]` (the root before the first move).
 */
export function retryItems(
  annotations: ReplayMoveAnnotation[],
  fenHistory: string[],
  nodeIds: string[],
  side: 'white' | 'black',
  rootId = 'root',
): RetryItem[] {
  return reviewSide(annotations, side)
    .costly.filter((move) => move.label && RETRIED.has(move.label) && fenHistory[move.ply - 1])
    .sort((a, b) => (b.cpLoss ?? 0) - (a.cpLoss ?? 0))
    .slice(0, MAX_RETRIES)
    .sort((a, b) => a.ply - b.ply)
    .map((move) => ({
      ply: move.ply,
      san: move.san,
      uci: move.uci,
      label: move.label!,
      cpLoss: move.cpLoss,
      fenBefore: fenHistory[move.ply - 1],
      lastUci:
        move.ply >= 2 ? (annotations.find((a) => a.ply === move.ply - 1)?.uci ?? null) : null,
      parentNodeId: move.ply >= 2 ? nodeIds[move.ply - 2] : rootId,
      bestUci: move.bestMove,
    }))
    .filter((item) => Boolean(item.parentNodeId))
}

/** A score in centipawns, mates folded onto the same scale as the rest of the app. */
export function scoreToCp(score: EngineScore): number {
  if (score.type === 'cp') return Math.max(-1500, Math.min(1500, score.value))
  const distance = Math.min(Math.abs(score.value), 20)
  return score.value > 0 ? 2000 - distance * 10 : -2000 + distance * 10
}

export function winningChance(cp: number): number {
  return 1 / (1 + Math.exp(-0.00368208 * cp))
}

/**
 * Judge an attempt. `bestCp` is the position before the move, from the
 * mover's side; `attemptCp` the position after the attempt, from the same side.
 */
export function judgeRetry({
  attemptUci,
  gameUci,
  bestUci,
  bestCp,
  attemptCp,
}: {
  attemptUci: string
  gameUci: string
  bestUci: string | null
  bestCp?: number | null
  attemptCp?: number | null
}): RetryVerdict {
  if (attemptUci === gameUci) return 'same'
  if (bestUci && attemptUci === bestUci) return 'best'
  if (bestCp == null || attemptCp == null) return 'worse'
  return winningChance(bestCp) - winningChance(attemptCp) <= GOOD_ENOUGH ? 'good' : 'worse'
}
