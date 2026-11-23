import type { RatingGoal } from './types'

const MONTH = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const SHORT_MONTH = new Intl.DateTimeFormat(undefined, { month: 'short' })

function signed(value: number): string {
  const rounded = Math.round(value)
  return rounded > 0 ? `+${rounded}` : `${rounded}`
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

export function monthOf(date: string, short = false): string {
  return (short ? SHORT_MONTH : MONTH).format(new Date(`${date}T12:00:00`))
}

const GOAL_KEY = 'chessgod.ratingGoal'

export function readRatingGoal(username: string, timeClass: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(`${GOAL_KEY}.${username}.${timeClass}`))
    return Number.isFinite(value) && value >= 400 && value <= 3200 ? value : null
  } catch {
    return null
  }
}

export function writeRatingGoal(username: string, timeClass: string, goal: number) {
  try {
    window.localStorage.setItem(`${GOAL_KEY}.${username}.${timeClass}`, String(goal))
  } catch {
    // A private window: the goal lasts for this visit.
  }
}

/**
 * Where the goal stands, without promising what the numbers do not show: a
 * date only for a real climb, and the score against players already at the
 * goal as the measure of the gap.
 */
export function describeRatingGoal(data: RatingGoal): { headline: string; detail: string | null } {
  const { current, goal } = data
  if (current == null) {
    return { headline: `No ${data.time_class} games in the last year.`, detail: null }
  }
  let headline: string
  if (current >= goal) {
    headline = `You made it: ${current}. Pick a higher goal.`
  } else if (data.eta && data.pace_per_month != null) {
    headline = `At ${signed(data.pace_per_month)} a month, you reach ${goal} around ${monthOf(data.eta)}.`
  } else if (data.pace_per_month == null) {
    headline = `${goal - current} points to go. Too few recent games to measure your pace.`
  } else {
    const recent =
      data.change_30d && data.change_30d > 0
        ? ` The last 30 days are ${signed(data.change_30d)}, though.`
        : ''
    headline = `${goal - current} points to go. No steady climb yet: ${signed(data.pace_per_month)} a month over 90 days.${recent}`
  }
  const parts: string[] = []
  const atGoal = data.vs_goal
  if (atGoal?.score != null) {
    parts.push(
      `Against players around ${goal} you score ${percent(atGoal.score)} (${atGoal.games.toLocaleString()} games). Players rated ${goal} score about 50%.`,
    )
  } else if (current < goal) {
    parts.push(`Too few games against players around ${goal} to compare yet.`)
  }
  if (data.vs_level?.score != null) {
    parts.push(`At your own level you score ${percent(data.vs_level.score)}.`)
  }
  return { headline, detail: parts.join(' ') || null }
}
