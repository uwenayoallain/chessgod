/**
 * Plain-language readings of the training numbers.
 *
 * The panel used to print "113 positions · 114 times seen · 0% drill accuracy",
 * which raises more questions than it answers: positions and times-seen look
 * like the same thing, and a flat 0% does not say whether it comes from one
 * wrong answer or a hundred.
 */

export type PatternStats = {
  positions: number
  occurrences: number
  drill_attempts: number
  drill_correct_rate: number | null
}

/** "113 positions, seen 114 times across your games". */
export function describeCoverage(stats: Pick<PatternStats, 'positions' | 'occurrences'>): string {
  const positions = `${stats.positions.toLocaleString()} ${stats.positions === 1 ? 'position' : 'positions'}`
  // Occurrences only add something when the theme actually repeats; otherwise
  // the two numbers are the same and printing both reads as a mistake.
  if (stats.occurrences <= stats.positions) return positions
  return `${positions}, seen ${stats.occurrences.toLocaleString()} times`
}

/** Accuracy that says what it is a share of. */
export function describeAccuracy(
  stats: Pick<PatternStats, 'drill_attempts' | 'drill_correct_rate'>,
): string {
  if (stats.drill_correct_rate == null || stats.drill_attempts === 0) return 'not drilled yet'
  const percent = Math.round(stats.drill_correct_rate * 100)
  const attempts = `${stats.drill_attempts} ${stats.drill_attempts === 1 ? 'try' : 'tries'}`
  return `${percent}% correct over ${attempts}`
}

/**
 * How the session length is arrived at, so "~7 min" is not a number from nowhere.
 *
 * The server fills a fixed time budget rather than a fixed count, which is why
 * the set stops at ten or so positions however many are available.
 */
export function describeSessionEstimate({
  drillCount,
  sessionSeconds,
  availablePositions,
}: {
  drillCount: number
  sessionSeconds: number
  availablePositions: number
}): string {
  const minutes = Math.max(1, Math.round(sessionSeconds / 60))
  const scope =
    availablePositions > drillCount
      ? `${drillCount} of ${availablePositions.toLocaleString()} positions`
      : `${drillCount} ${drillCount === 1 ? 'position' : 'positions'}`
  return `${scope}, about ${minutes} min — roughly 40s for a one-move lesson and 60s for a two-move one, filling a ten-minute session.`
}
