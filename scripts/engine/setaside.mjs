/**
 * Positions the crawler could not finish, and when it will try them again.
 *
 * A search that times out is reported to the queue as an exclusion, or the
 * queue hands it straight back every batch. That set used to last for the rest
 * of the process: thirteen timeouts accumulated over three days, and once the
 * queue's newest work was exactly those thirteen positions a one-engine crawl
 * got an empty batch every minute for thirty hours while a GET of the same
 * endpoint returned 500 positions.
 *
 * A timeout is a statement about one attempt, not about the position -- most of
 * these ran on a package throttled at 85-90C, and a depth-34 search that cannot
 * finish in three minutes then may well finish on a cool machine -- so a set-
 * aside position comes back after a while, and each failure doubles the wait.
 * The backoff is what keeps a position that genuinely cannot finish from costing
 * a full search timeout every batch: after a few failures it is tried about
 * once every `maxMs`.
 */

export function createSetAside({ baseMs = 6 * 3_600_000, maxMs = 48 * 3_600_000, clock = Date.now } = {}) {
  // fen -> { failures, retryAt }. Insertion order is recency: a fresh failure
  // is re-inserted at the end, so a capped exclusion list keeps the newest.
  const entries = new Map()

  function waiting(now) {
    return [...entries].filter(([, entry]) => entry.retryAt > now)
  }

  return {
    /** Records one failed search and returns when the position comes back. */
    add(fen) {
      const failures = (entries.get(fen)?.failures ?? 0) + 1
      const delayMs = Math.min(maxMs, baseMs * 2 ** (failures - 1))
      entries.delete(fen)
      entries.set(fen, { failures, retryAt: clock() + delayMs })
      return { failures, delayMs }
    },

    /** A search of the position finished: forget it. */
    resolved(fen) {
      entries.delete(fen)
    },

    /** Positions to exclude from the next queue request, oldest first. */
    excluded() {
      return waiting(clock()).map(([fen]) => fen)
    },

    /** How many positions are being held back right now. */
    get size() {
      return waiting(clock()).length
    },

    /** Milliseconds until the next held-back position is offered again, or null. */
    nextRetryMs() {
      const now = clock()
      const pending = waiting(now)
      if (pending.length === 0) return null
      return Math.min(...pending.map(([, entry]) => entry.retryAt)) - now
    },
  }
}
