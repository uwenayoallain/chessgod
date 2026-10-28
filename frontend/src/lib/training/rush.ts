import type { RepertoireCheck, RepertoireDeviation } from './types'

/** "2:05", "0:09": the Rush clock. */
export function formatRushTime(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** What a finished run means against the best, in a line. */
export function rushVerdict(score: number, best: number): string {
  if (score === 0) return 'No moves this time. The first ones are the easiest, so go again.'
  if (score >= best) return `${score} moves from memory. Your best run.`
  const gap = best - score
  return `${score} moves from memory. ${gap} short of your best of ${best}.`
}

const RESULT_WORDS: Record<string, string> = { win: 'won', loss: 'lost', draw: 'drew' }

/** "Yesterday you played 5...Nf6 (lost) — the repertoire move is Qf6." */
export function describeDeviation(item: RepertoireDeviation, now = new Date()): string {
  // Calendar days, not 24-hour spans: a game at 8pm yesterday is "yesterday" at noon.
  const midnight = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((midnight(now) - midnight(new Date(item.played_at))) / 86_400_000)
  const when = days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`
  const moveNumber = Math.ceil(item.ply / 2)
  const played =
    item.ply % 2 === 1 ? `${moveNumber}.${item.played_san}` : `${moveNumber}...${item.played_san}`
  const result = RESULT_WORDS[item.result] ?? item.result
  return `${when} you played ${played} and ${result}. Your repertoire move is ${item.expected_san}.`
}

/** How faithful the latest games were to the repertoire. */
export function describeCheck(check: RepertoireCheck): string | null {
  if (!check.games_checked) return null
  const share = Math.round((check.games_followed / check.games_checked) * 100)
  return `In your repertoire for ${check.games_followed.toLocaleString()} of your last ${check.games_checked.toLocaleString()} games (${share}%).`
}

/** The lines to review after a check, most recent deviation first, each once. */
export function deviationLineIds(check: RepertoireCheck, color: 'white' | 'black'): string[] {
  return [
    ...new Set(check.deviations.filter((item) => item.color === color).map((item) => item.line_id)),
  ]
}

/** The question, in the player's terms: what they did, and what kind of reply punishes it. */
export function threatPrompt(question: {
  your_move_san: string
  kind: 'capture' | 'check' | 'mate'
  ply: number
}): string {
  const moveNumber = Math.ceil(question.ply / 2)
  const move =
    question.ply % 2 === 1
      ? `${moveNumber}.${question.your_move_san}`
      : `${moveNumber}...${question.your_move_san}`
  const reply = {
    capture: 'Now your opponent can win material',
    check: 'Now your opponent has a check that wins',
    mate: 'Now your opponent has a mating attack',
  }[question.kind]
  return `You played ${move}. ${reply}. Find their move.`
}

/** What the answer teaches: the punishment, and the move that would have avoided it. */
export function threatLesson(
  answer: { correct: boolean; reply_san: string; better_san: string },
  played: string,
): string {
  const avoid = `${answer.better_san} would have avoided it.`
  return answer.correct
    ? `Spotted: ${answer.reply_san}. ${avoid}`
    : `${played} isn't it. The move was ${answer.reply_san}. ${avoid} Before every move, look at their captures and checks first.`
}

/** The end of a set, and the habit behind it. */
export function threatSummary(spotted: number, total: number): string {
  if (!total) return ''
  if (spotted === total)
    return `All ${total} spotted. Now run the same scan before every move in your games.`
  return `${spotted} of ${total} spotted. The same scan would have caught each miss in your games.`
}

/** Punish it: the opponent's mistake, asked from the player's chair. */
export function punishPrompt(question: {
  their_move_san: string
  kind: 'capture' | 'check' | 'mate'
  ply: number
}): string {
  // `ply` is the player's own move; the opponent's mistake was the ply before.
  const theirPly = question.ply - 1
  const moveNumber = Math.ceil(theirPly / 2)
  const move =
    theirPly % 2 === 1
      ? `${moveNumber}.${question.their_move_san}`
      : `${moveNumber}...${question.their_move_san}`
  const chance = {
    capture: 'You can win material',
    check: 'You have a check that wins',
    mate: 'You have a mating attack',
  }[question.kind]
  return `Your opponent played ${move}, a mistake. ${chance}. Find your move.`
}

export function punishLesson(
  answer: { correct: boolean; answer_san: string; your_move_san: string },
  played: string,
): string {
  const game = `In the game you played ${answer.your_move_san} and gave it back.`
  return answer.correct
    ? `Found: ${answer.answer_san}. ${game}`
    : `${played} isn't it. ${answer.answer_san} punishes it. ${game} When their move surprises you, look at your captures and checks first.`
}

export function punishSummary(found: number, total: number): string {
  if (!total) return ''
  if (found === total)
    return `All ${total} found. Look for the same in your games when their move surprises you.`
  return `${found} of ${total} found. Each one was a gift you handed back in a real game.`
}
