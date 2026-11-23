/**
 * Turns "N of M done" plus elapsed time into a rate and a finishing estimate.
 *
 * Analysing a game takes minutes and a whole library takes days, so a bare
 * percentage is not enough information to decide whether to wait. The estimate
 * is deliberately coarse — it is derived from this run only, and rounded — so
 * it reads as the guess it is.
 */
export type RateEstimate = {
  /** Positions per minute, or null before two data points exist. */
  perMinute: number | null
  /** Seconds until the run finishes, or null when it cannot be estimated. */
  etaSeconds: number | null
}

export function estimateRate({
  completed,
  total,
  elapsedMs,
}: {
  completed: number
  total: number
  elapsedMs: number
}): RateEstimate {
  if (completed <= 0 || elapsedMs <= 0) return { perMinute: null, etaSeconds: null }

  const perMinute = (completed / elapsedMs) * 60_000
  const remaining = Math.max(0, total - completed)

  return {
    perMinute,
    etaSeconds: perMinute > 0 ? Math.round((remaining / perMinute) * 60) : null,
  }
}

/**
 * A duration a person can act on. Anything past a couple of days stops being a
 * number worth reading precisely and becomes a reason to do something else.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown'
  if (seconds < 60) return 'under a minute'

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes === 0 ? `${hours} hr` : `${hours} hr ${restMinutes} min`

  const days = Math.round(hours / 24)
  return `${days} days`
}
