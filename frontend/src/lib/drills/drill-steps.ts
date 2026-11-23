import type { DrillCard } from '@/hooks/use-improvement'

/**
 * Which move of a drill the player is being asked for, and what the answer is.
 *
 * A calculation drill can run two plies: play the move, see the reply, play the
 * follow-up it depends on. The card holds both, but everything the panel showed
 * described the *first* step — so someone stuck on the second move and asking
 * for the solution was told the move they had already found, and the header
 * still read a flat "2 moves" with no sign of where they were.
 */
export type DrillStep = {
  /** 1-based, so it reads the way it is displayed. */
  index: number
  count: number
  /** The move being asked for right now. */
  answerSan: string
  answerUci: string
}

export type DrillStatusForStep = 'solving' | 'follow-up'

export function drillStepCount(card: Pick<DrillCard, 'follow_up'>): number {
  return card.follow_up ? 2 : 1
}

export function drillStep(
  card: Pick<DrillCard, 'follow_up' | 'best_move_san' | 'best_move_uci'>,
  status: DrillStatusForStep,
): DrillStep {
  const count = drillStepCount(card)
  // Only a card that *has* a follow-up can be on its second step; a status left
  // over from another card must not index past the end of this one.
  const onFollowUp = status === 'follow-up' && card.follow_up != null
  return {
    index: onFollowUp ? 2 : 1,
    count,
    answerSan: onFollowUp ? card.follow_up!.best_move_san : card.best_move_san,
    answerUci: onFollowUp ? card.follow_up!.best_move_uci : card.best_move_uci,
  }
}

/** "Move 2 of 2", or nothing at all for a single-move drill. */
export function drillStepLabel(step: DrillStep): string | null {
  return step.count > 1 ? `Move ${step.index} of ${step.count}` : null
}

export type DrillLinePly = {
  san: string
  /** Whose move it is: the player's to find, or the opponent's reply. */
  side: 'player' | 'opponent'
  /** True for the ply the player was being asked for when they gave up. */
  isAnswer: boolean
}

/**
 * The whole line, with the ply the player was stuck on marked.
 *
 * Reading "the line runs Nxe5 Bxd1 Rxd1" does not say which of those was being
 * asked for, and that is the only part the reader is missing.
 */
export function drillLine(
  card: Pick<DrillCard, 'follow_up' | 'best_move_san'>,
  askedStepIndex: number,
): DrillLinePly[] {
  const line: DrillLinePly[] = [
    { san: card.best_move_san, side: 'player', isAnswer: askedStepIndex === 1 },
  ]
  if (card.follow_up) {
    line.push({ san: card.follow_up.opponent_reply_san, side: 'opponent', isAnswer: false })
    line.push({ san: card.follow_up.best_move_san, side: 'player', isAnswer: askedStepIndex === 2 })
  }
  return line
}
