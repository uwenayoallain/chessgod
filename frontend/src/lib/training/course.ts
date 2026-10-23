import { shortOpeningName } from '@/lib/analysis/points-lost'

import type { LineStatus, RepertoireLine, RepertoireStep, YourStep } from './types'

export type Chapter = {
  key: string
  title: string
  subtitle: string
  lines: RepertoireLine[]
  yourMoves: number
  knownMoves: number
  dueMoves: number
}

/** Numbered move text: "1.e4 e5 2.Nf3 Nc6 3.d4". */
export function formatLine(moves: Pick<RepertoireStep, 'san' | 'ply'>[], upTo?: number): string {
  const parts: string[] = []
  for (const step of moves.slice(0, upTo ?? moves.length)) {
    const moveNumber = Math.ceil(step.ply / 2)
    if (step.ply % 2 === 1) parts.push(`${moveNumber}.${step.san}`)
    else if (parts.length === 0) parts.push(`${moveNumber}...${step.san}`)
    else parts.push(step.san)
  }
  return parts.join(' ')
}

/** "4...Nf6" or "5.Bc4": one move, numbered for the side that plays it. */
export function numberedMove(step: Pick<RepertoireStep, 'san' | 'ply'>): string {
  const moveNumber = Math.ceil(step.ply / 2)
  return step.ply % 2 === 1 ? `${moveNumber}.${step.san}` : `${moveNumber}...${step.san}`
}

export function lineTitle(line: RepertoireLine): string {
  return shortOpeningName(line.name) ?? formatLine(line.moves, 4)
}

export function yourSteps(line: RepertoireLine): YourStep[] {
  return line.moves.filter((step): step is YourStep => step.side === 'you')
}

/**
 * Chapters the way a course has them: the fixes first — every line with a
 * move to change or a trap to punish, most-played first — then the rest by
 * what the opponent opened with. A line appears once.
 */
export function buildChapters(lines: RepertoireLine[], color: 'white' | 'black'): Chapter[] {
  const fixes = lines
    .filter((line) => line.changes > 0 || line.traps > 0)
    .sort((a, b) => Number(b.changes > 0) - Number(a.changes > 0) || b.games - a.games)
  const rest = lines.filter((line) => line.changes === 0 && line.traps === 0)
  const groups = new Map<string, RepertoireLine[]>()
  for (const line of rest) {
    // Black answers White's first move; White answers Black's first reply.
    const key = color === 'black' ? line.moves[0]?.san : line.moves[1]?.san
    const group = key ?? 'other'
    groups.set(group, [...(groups.get(group) ?? []), line])
  }
  const chapters: Chapter[] = []
  if (fixes.length) {
    chapters.push(
      chapter(
        'fix',
        'Fix these first',
        'Moves to change and traps to punish, from your games',
        fixes,
      ),
    )
  }
  const sorted = [...groups.entries()].sort(
    (a, b) => b[1].reduce((n, l) => n + l.games, 0) - a[1].reduce((n, l) => n + l.games, 0),
  )
  const big = sorted.filter(([, group]) => group.length >= 2).slice(0, 3)
  const small = sorted.filter((entry) => !big.includes(entry)).flatMap(([, group]) => group)
  for (const [move, group] of big) {
    const title = color === 'black' ? `Against 1.${move}` : `Against 1...${move}`
    chapters.push(chapter(`vs-${move}`, title, 'Lines you already play', group))
  }
  if (small.length) {
    chapters.push(chapter('other', 'Everything else', 'Sidelines you meet now and then', small))
  }
  return chapters
}

function chapter(key: string, title: string, subtitle: string, lines: RepertoireLine[]): Chapter {
  return {
    key,
    title,
    subtitle,
    lines,
    yourMoves: lines.reduce((n, line) => n + line.your_moves, 0),
    knownMoves: lines.reduce((n, line) => n + line.known_moves, 0),
    dueMoves: lines.reduce((n, line) => n + line.due_moves, 0),
  }
}

export const STATUS_LABELS: Record<LineStatus, string> = {
  new: 'New',
  learning: 'Learning',
  due: 'Review due',
  mastered: 'Mastered',
}

function pawns(cp: number): string {
  return (cp / 100).toFixed(1)
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

/** Why this move, in a sentence or two — what the course shows beside the board. */
export function explainStep(step: YourStep): string {
  const masters =
    step.master_share != null && step.master_games > 0
      ? `Masters play it in ${percent(step.master_share)} of games.`
      : null
  if (step.status === 'keep') {
    const games = step.usual_games
      ? `You've played this in ${step.usual_games.toLocaleString()} ${step.usual_games === 1 ? 'game' : 'games'}.`
      : 'You already play this.'
    return step.reason === 'unchecked'
      ? `${games} The engine hasn't checked the alternatives yet.`
      : `${games} It's sound, so keep it.`
  }
  const why: string[] = []
  if (step.status === 'change' && step.usual_san) {
    const record =
      step.usual_score != null
        ? ` in ${step.usual_games.toLocaleString()} ${step.usual_games === 1 ? 'game' : 'games'} and scored ${percent(step.usual_score)}`
        : ''
    const loss =
      step.usual_loss_cp != null && step.usual_loss_cp > 0
        ? ` It gives away ${pawns(step.usual_loss_cp)} pawns.`
        : ''
    why.push(`You played ${step.usual_san} here${record}.${loss}`)
  }
  why.push(
    step.status === 'change' ? `${step.san} keeps the balance.` : `${step.san} is the move here.`,
  )
  if (masters) why.push(masters)
  if (step.idea_san) why.push(`The engine's line: ${step.idea_san}.`)
  return why.join(' ')
}

/** A trap the opponent walks into, and what it costs them. */
export function explainTrap(step: RepertoireStep): string | null {
  if (step.side !== 'opponent' || step.trap_cp == null) return null
  const often = step.games
    ? ` Opponents have played it against you ${step.games.toLocaleString()} times.`
    : ''
  return `${step.san} is a mistake that gives away ${pawns(step.trap_cp)} pawns.${often} Punish it.`
}

/** What is at stake in a line, in the player's own results. */
export function lineStakes(line: RepertoireLine): string {
  const change = yourSteps(line).find((step) => step.status === 'change')
  const reached = `Reached in ${line.games.toLocaleString()} of your games`
  if (change?.usual_san && change.usual_loss_cp) {
    const record =
      change.usual_score != null ? `, and you scored ${percent(change.usual_score)} after it` : ''
    return `${reached}. ${change.usual_san} gives away ${pawns(change.usual_loss_cp)} pawns${record}.`
  }
  if (change?.usual_san && change.usual_score != null) {
    return `${reached}. You scored ${percent(change.usual_score)} after ${change.usual_san}.`
  }
  if (line.traps) return `${reached}. Opponents fall into a trap here.`
  return `${reached}.`
}

/** Lines with moves due, most due first: a review session's queue. */
export function dueLines(lines: RepertoireLine[]): RepertoireLine[] {
  return lines.filter((line) => line.due_moves > 0).sort((a, b) => b.due_moves - a.due_moves)
}

/** The next line to learn: the biggest unlearned fix, else the most-played new line. */
export function nextLineToLearn(
  lines: RepertoireLine[],
  color: 'white' | 'black',
): RepertoireLine | null {
  for (const chapter of buildChapters(lines, color)) {
    const line = chapter.lines.find((item) => item.status === 'new')
    if (line) return line
  }
  return null
}
