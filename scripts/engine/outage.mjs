/**
 * What the crawler does when the queue stops answering.
 *
 * The crawler has exactly one source of work (`GET /api/games/unanalyzed-fens`)
 * and one place to put a result, so a backend that is down does not slow it
 * down, it stops it completely. That failure used to read like this, once every
 * thirty-five seconds:
 *
 *     queue unavailable (fetch failed); retrying
 *
 * for thirty-five hours -- about 3,600 identical lines, a container still
 * reporting Up, and coverage frozen at 45.91% the whole time. Nothing in that
 * line says how long it has been going on, or that the backend is the thing
 * that is missing, so `docker compose logs --tail` looked the same after a day
 * as it did after a minute.
 *
 * Two changes, both aimed at that:
 *
 *  - the retry backs off geometrically to a ceiling, so a long outage costs a
 *    request every few minutes rather than every thirty-five seconds;
 *  - every line carries how long the queue has been unreachable and what the
 *    health probe says about the backend, and the recovery is logged too, so
 *    the log states the outage rather than merely repeating during it.
 *
 * It never ends the run: the crawl is meant to survive a backend restart, and
 * exiting would restart-loop under `unless-stopped`.
 */

/** Durations a person reads at a glance: `45s`, `4m 10s`, `35h 12m`. */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

// What the health probe found, and what that means for whoever reads the log.
// "unknown" is deliberately distinct from "down": a probe we could not run is
// not evidence that the backend is missing, and saying so would send someone to
// restart a service that is fine.
const DIAGNOSIS = {
  down: 'backend is not answering /api/health, so there is no work to take and nowhere to put a result',
  up: 'backend is healthy, so the queue endpoint itself is failing',
  unknown: 'backend health could not be probed',
}

/**
 * Tracks one continuous outage. `clock` is injected so the tests can age an
 * outage without waiting for one.
 */
export function createOutage({ baseMs = 30_000, maxMs = 300_000, clock = Date.now } = {}) {
  let attempts = 0
  let startedAt = null

  return {
    get failing() { return attempts > 0 },

    /** Records one failed queue fetch and returns the delay and the line to log. */
    fail(reason, { backend = 'unknown' } = {}) {
      const at = clock()
      if (startedAt == null) startedAt = at
      attempts += 1
      const downMs = at - startedAt
      // Doubling from the normal poll interval up to the ceiling. The first
      // retry is still prompt, because most outages are a backend restart.
      const delayMs = Math.min(maxMs, baseMs * 2 ** (attempts - 1))
      const since = downMs > 0 ? ` for ${formatDuration(downMs)}` : ''
      return {
        attempts,
        downMs,
        delayMs,
        message: `queue unavailable${since} (${reason}); ${DIAGNOSIS[backend] ?? DIAGNOSIS.unknown}`
          + `; attempt ${attempts}, retrying in ${formatDuration(delayMs)}`,
      }
    },

    /**
     * Clears the outage. Returns the line to log when one had been running, and
     * null otherwise -- a crawl that never lost the queue says nothing.
     */
    recover() {
      if (attempts === 0) return null
      const downMs = clock() - startedAt
      const recovered = { downMs, attempts, message: `queue reachable again after ${formatDuration(downMs)} unavailable (${attempts} attempts)` }
      attempts = 0
      startedAt = null
      return recovered
    },
  }
}
