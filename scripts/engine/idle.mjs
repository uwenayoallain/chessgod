// How long to wait before asking again when the queue had nothing to offer.
//
// With the library 99.4% analysed the queue is empty most of the time, and
// asking every 60s cost a pool walk on the backend each time (3-10s of
// Postgres, measured) for an answer that had not changed. The wait doubles
// while the library's counts stay the same, up to a ceiling, and starts over
// the moment they move: an import or an upload is new work, or new coverage.

export function createIdleWait({ baseMs, maxMs }) {
  let waitMs = baseMs
  let lastSignature = null
  return {
    /** The wait after a batch that offered nothing, for the counts it carried. */
    next(signature) {
      waitMs = signature === lastSignature ? Math.min(waitMs * 2, maxMs) : baseMs
      lastSignature = signature
      return waitMs
    },
    /** A batch with work in it: the next empty one starts from the base again. */
    reset() {
      waitMs = baseMs
      lastSignature = null
    },
  }
}
