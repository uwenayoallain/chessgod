/**
 * Why the trainer has no card to show.
 *
 * The plan is fetched per theme when one is selected, so its `drills` array is
 * theme-scoped while `summary.due_positions` counts the whole library. Reading
 * an empty `drills` as "no lessons at all" told users with seven lessons
 * waiting to go and analyse more games.
 */
export type LessonAvailability =
  /** Nothing anywhere: the engine has not found a repeat mistake yet. */
  | { kind: 'none' }
  /** This theme is drilled out, but other themes still have lessons. */
  | { kind: 'theme-clear'; elsewhere: number }
  /** There are cards to show. */
  | { kind: 'ready' }

export function getLessonAvailability({
  drillCount,
  selectedPattern,
  selectedDue,
  totalDue,
}: {
  drillCount: number
  selectedPattern: string | null
  /** Lessons ready in the selected theme, if one is selected. */
  selectedDue: number | null
  /** Lessons ready across every theme. */
  totalDue: number
}): LessonAvailability {
  if (drillCount > 0) return { kind: 'ready' }

  if (selectedPattern) {
    const elsewhere = Math.max(0, totalDue - (selectedDue ?? 0))
    if (elsewhere > 0) return { kind: 'theme-clear', elsewhere }
  }

  return { kind: 'none' }
}

/**
 * The count the header should show: whatever the panel below it is actually
 * listing, so the badge and the body can never contradict each other.
 */
export function readyCountInView({
  selectedPattern,
  selectedDue,
  totalDue,
}: {
  selectedPattern: string | null
  selectedDue: number | null
  totalDue: number
}): number {
  return selectedPattern ? (selectedDue ?? 0) : totalDue
}
