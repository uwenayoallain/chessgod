/**
 * The theme to recommend: the first with positions ready, skipping the one
 * trained most recently today. A finished set used to come straight back as
 * the recommendation the moment it ended, because "recommended" was simply
 * the first theme in the list.
 */
export function recommendedTheme(
  patterns: { key: string; due_positions: number }[],
  trainedToday: string | null,
): string | null {
  const ready = patterns.filter((pattern) => pattern.due_positions > 0)
  return (
    ready.find((pattern) => pattern.key !== trainedToday)?.key ??
    ready[0]?.key ??
    patterns[0]?.key ??
    null
  )
}
