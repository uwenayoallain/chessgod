import type { ClockReport } from './types'

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

/** "10-minute" or "3+2", the way players name a control. */
export function controlName(report: ClockReport): string {
  const minutes = (report.initial_seconds ?? 0) / 60
  const shown = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1)
  return report.increment ? `${shown}+${report.increment}` : `${shown}-minute`
}

const BLUNDER_CHECK_HABIT =
  'Before a capture, a check or a move that hangs a piece: ten seconds. What does it allow?'

/**
 * What the clock says about the player's mistakes, in their own numbers. The
 * advice follows the verdict: unused time and time trouble want opposite fixes.
 */
export function describeClock(report: ClockReport): {
  headline: string
  detail: string | null
  advice: string | null
} {
  if (report.verdict === 'insufficient' || !report.initial_seconds) {
    return {
      headline: 'Not enough analyzed games with clocks yet.',
      detail: `This needs ${(20).toLocaleString()} games and ${(30).toLocaleString()} analyzed big mistakes in one time control.`,
      advice: null,
    }
  }
  const control = controlName(report)
  const initial = formatClock(report.initial_seconds)
  const lossLeft = report.left_in_losses != null ? formatClock(report.left_in_losses) : null
  const think = report.mistake_think != null ? `${Math.round(report.mistake_think)} seconds` : null
  const left = report.mistake_left != null ? formatClock(report.mistake_left) : null
  if (report.verdict === 'time_trouble') {
    return {
      headline: 'You get into time trouble.',
      detail: `${percent(report.mistakes_in_time_trouble ?? 0)} of your big mistakes in ${control} games came with under a tenth of your clock left.`,
      advice: 'Play your repertoire moves fast and save a minute for the end.',
    }
  }
  if (report.verdict === 'unused') {
    return {
      headline: lossLeft
        ? `You lose ${control} games with ${lossLeft} of ${initial} still on your clock.`
        : 'You lose with time still on your clock.',
      detail: `${percent(report.mistakes_with_half_clock ?? 0)} of your big mistakes came with half your clock or more left, and ${percent(report.hasty_mistakes ?? 0)} took under ten seconds.${think && left ? ` The typical one took ${think}, with ${left} left.` : ''} Only ${percent(report.mistakes_in_time_trouble ?? 0)} came in time trouble.`,
      advice: BLUNDER_CHECK_HABIT,
    }
  }
  return {
    headline: "Your clock isn't the problem.",
    detail:
      think && left
        ? `Your big mistakes take ${think} on average with ${left} left, and your losses end with ${lossLeft ?? 'little'} on the clock.`
        : null,
    advice: BLUNDER_CHECK_HABIT,
  }
}

/** The clock left at the end that went best, against the one the player usually has. */
export function describeFinish(report: ClockReport): string | null {
  const bands = (report.by_finish ?? []).filter((band) => band.games >= 20 && band.score != null)
  if (bands.length < 2) return null
  const best = bands.reduce((a, b) => (b.score! > a.score! ? b : a))
  const usual = bands.reduce((a, b) => (b.games > a.games ? b : a))
  if (best.label === usual.label) {
    return `Games past move 30 went best with ${best.label.toLowerCase()} of the clock left. Most of yours do.`
  }
  return `Games past move 30: ${percent(best.score!)} with ${best.label.toLowerCase()} of the clock left, ${percent(usual.score!)} with ${usual.label.toLowerCase()}, where most of yours end.`
}
