import type { ProgressGame, TrainingProgress } from './types'

// A change smaller than this is noise between two 20-game windows.
const MEANINGFUL = 0.1
const ROLLING = 10

function fixed(value: number) {
  return value.toFixed(1)
}

/**
 * Whether the latest games are better than the ones before, said plainly —
 * including when results and mistakes point different ways, which is exactly
 * when a player should not be told what they want to hear.
 */
export function describeProgress(progress: TrainingProgress): {
  headline: string
  detail: string | null
} {
  const { recent, previous } = progress
  if (!recent || !previous) {
    return {
      headline: 'Not enough analyzed games for a trend yet.',
      detail: `Needs 40 analyzed games. ${progress.games.length.toLocaleString()} of your last ${progress.checked_games.toLocaleString()} are.`,
    }
  }
  const change = previous.big_errors ? recent.big_errors / previous.big_errors - 1 : 0
  const scoreUp = recent.score - previous.score >= MEANINGFUL
  const scoreDown = previous.score - recent.score >= MEANINGFUL
  const now = fixed(recent.big_errors)
  const before = fixed(previous.big_errors)
  let headline: string
  if (change <= -MEANINGFUL) {
    headline = `Fewer big mistakes: ${now} a game, down from ${before}.`
  } else if (change >= MEANINGFUL) {
    headline = `More big mistakes lately: ${now} a game, up from ${before}.`
  } else {
    headline = `About the same: ${now} big mistakes a game, against ${before} before.`
  }
  let detail: string | null = null
  if (change >= MEANINGFUL && scoreUp) {
    detail = "Your results are up anyway. You're winning in spite of the mistakes."
  } else if (change <= -MEANINGFUL && scoreDown) {
    detail =
      "Your results haven't caught up yet. They usually take a few weeks to follow cleaner games."
  } else if (recent.forcing_errors >= 1) {
    detail = `${fixed(recent.forcing_errors)} a game were a capture or check you allowed or missed. Blunder Check trains that.`
  }
  return { headline, detail }
}

/** Since the first training session against the games before it, once there are enough to say. */
export function describeSinceTraining(progress: TrainingProgress): string | null {
  const since = progress.since_training
  const before = progress.before_training
  if (!since || !before || since.games < 5) return null
  return `Since training began (${since.games.toLocaleString()} games): ${fixed(since.big_errors)} big mistakes a game, ${fixed(before.big_errors)} before.`
}

/** "↓ 1.4" / "↑ 0.3" / "—": a change and which way is good. */
export function delta(
  now: number | null | undefined,
  before: number | null | undefined,
  { lowerIsBetter, digits = 1 }: { lowerIsBetter: boolean; digits?: number },
): { text: string; good: boolean | null } {
  if (now == null || before == null) return { text: '—', good: null }
  const diff = now - before
  if (Math.abs(diff) < 10 ** -digits / 2) return { text: 'same', good: null }
  return {
    text: `${diff < 0 ? '↓' : '↑'} ${Math.abs(diff).toFixed(digits)}`,
    good: lowerIsBetter ? diff < 0 : diff > 0,
  }
}

export function percent(share: number | undefined) {
  return share == null ? '—' : `${Math.round(share * 100)}%`
}

/** The rolling mean of big mistakes a game, oldest first: the trend line's points. */
export function rollingBigErrors(
  games: ProgressGame[],
  window = ROLLING,
): { game: ProgressGame; value: number }[] {
  const oldestFirst = [...games].reverse()
  return oldestFirst.map((game, index) => {
    const slice = oldestFirst.slice(Math.max(0, index - window + 1), index + 1)
    return { game, value: slice.reduce((total, item) => total + item.big_errors, 0) / slice.length }
  })
}
