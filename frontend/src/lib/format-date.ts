// One formatter for every date the app prints. `toLocaleDateString(undefined,
// options)` builds a new Intl formatter on each call, and the game lists called
// it for every row on every render — ~150ms per 20 board steps, measured.
const gameDate = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
})

/** A played-at timestamp as "Sep 12, 2026" in the reader's locale. */
export function formatGameDate(value: string) {
  return gameDate.format(new Date(value))
}
