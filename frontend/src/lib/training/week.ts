import type { WeekScoresheet } from './types'

const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })

export function weekLabel(sheet: WeekScoresheet): string {
  const start = DAY.format(new Date(`${sheet.week}T12:00:00`))
  const end = DAY.format(new Date(`${sheet.ends}T12:00:00`))
  return `${start} – ${end}`
}

/** "12 games · 5–1–6 · 46%": the week's result line. */
export function weekLine(sheet: WeekScoresheet): string {
  if (!sheet.played) return 'No rapid or blitz games this week.'
  const games = `${sheet.played.toLocaleString()} ${sheet.played === 1 ? 'game' : 'games'}`
  const score = sheet.score != null ? ` · ${Math.round(sheet.score * 100)}%` : ''
  return `${games} · ${sheet.wins}–${sheet.draws}–${sheet.losses}${score}`
}

/** Each time control's rating across the week: "Rapid 1694 → 1692 (−2)". */
export function ratingLines(sheet: WeekScoresheet): string[] {
  return Object.entries(sheet.ratings).map(([timeClass, { from, to }]) => {
    const change = to - from
    const sign = change > 0 ? '+' : change < 0 ? '−' : '±'
    const name = timeClass.charAt(0).toUpperCase() + timeClass.slice(1)
    return `${name} ${from} → ${to} (${sign}${Math.abs(change)})`
  })
}

/** What the training aimed at, counted over the week's games. */
export function habitsLine(sheet: WeekScoresheet): string | null {
  const parts: string[] = []
  if (sheet.book_games)
    parts.push(`${sheet.in_book} of ${sheet.book_games} followed your repertoire`)
  if (sheet.clock_used) parts.push(`good clock use in ${sheet.clock_used}`)
  parts.push(sheet.xp ? `${sheet.xp.toLocaleString()} XP trained` : 'no training')
  return parts.length ? `${parts.join(' · ')}.` : null
}
