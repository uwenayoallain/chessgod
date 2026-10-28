/**
 * Is somebody using this machine right now, and how long since they last were?
 *
 * Everything else in the pool controller is *reactive*: the load average and
 * CPU pressure only rise once the crawler is already competing with the person
 * at the keyboard, so relief always arrives after they have felt it. Repeatedly
 * "fixing" the lag by reacting faster has diminishing returns -- the surge is
 * caused by the pool growing while someone is present, and the answer is not to
 * grow then.
 *
 * So presence is measured directly instead of inferred. /proc/stat is host-wide
 * even inside the container, and the container's own cgroup reports exactly what
 * we used; the difference is what everyone else used, in cores, over whatever
 * interval we sampled. Measured on this box: 0.07-0.20 cores with the machine
 * quiet, 1.36-1.94 while its owner was working -- a clean order-of-magnitude
 * gap, sampled in two seconds rather than the load average's sixty.
 */

/** Busy and total CPU-seconds from the first line of /proc/stat. */
export function parseProcStat(text) {
  const fields = String(text ?? '').split('\n')[0].trim().split(/\s+/)
  if (fields[0] !== 'cpu' || fields.length < 9) return null
  const counters = fields.slice(1, 9)
  if (!counters.every(value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))) return null
  const [user, nice, sys, idle, iowait, irq, softirq, steal] =
    counters.map(Number)
  // USER_HZ is 100 on every Linux target we run on. iowait is not busy: a core
  // waiting on disk is available to someone else.
  const busy = (user + nice + sys + irq + softirq + steal) / 100
  return { busy, total: (busy + (idle + iowait) / 100) }
}

/** CPU-seconds this container has used, from cgroup v2 cpu.stat. */
export function parseCgroupUsage(text) {
  const match = /^usage_usec[ \t]+(\d+)[ \t]*$/m.exec(String(text ?? ''))
  return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) / 1e6 : null
}

/**
 * Cores used by everything except us, between two samples.
 *
 * Returns null when a sample is missing or the clock did not advance, so the
 * caller keeps its previous belief rather than reading a gap as idleness.
 */
export function otherCoresBetween(previous, current) {
  if (!previous || !current) return null
  if (![previous.busy, previous.ours, previous.at, current.busy, current.ours, current.at]
    .every(Number.isFinite)) return null
  const seconds = (current.at - previous.at) / 1000
  if (!(seconds > 0)) return null
  const busy = current.busy - previous.busy
  const ours = current.ours - previous.ours
  // A reset is a new baseline, not evidence that the host became idle.
  if (busy < 0 || ours < 0) return null
  return Math.max(0, (busy - ours) / seconds)
}

/**
 * The pool ceiling implied by how recently somebody used the machine.
 *
 * While they are present -- or were recently enough that they are probably
 * still there -- the crawler is capped hard rather than being allowed to grow
 * and then be pushed back. It only unlocks the full pool after the machine has
 * been genuinely quiet for `idleAfterMs`.
 */
export function presenceCeiling({ msSinceActive, idleAfterMs, activeMax, fullMax }) {
  return msSinceActive >= idleAfterMs ? fullMax : Math.min(activeMax, fullMax)
}

/**
 * The crawler's own requests, so presence can tell its backend from a person.
 *
 * "Other people's CPU" is machine busy minus this container, which counts our
 * own backend and Postgres as somebody else. Most of the time they are idle, but
 * a queue pool rebuild costs ~4.8 core-seconds over ~3s -- 1.67 cores, over three
 * times `CRAWL_ACTIVE_CORES` -- and the pool expired every 600s, exactly the
 * `CRAWL_IDLE_AFTER_MS` window one busy sample holds. So the crawler's own
 * request kept the machine "in use" around the clock: every hour of a measured
 * day, 04:00-07:00 included, ran at one engine under the 80C attended line,
 * standing down for heat 39% of the time. That work happens only while we are
 * waiting on it, so a sample whose window overlaps one of our requests says
 * nothing about people and is dropped, like an unmeasurable one.
 */
export function createOwnWork({ clock = Date.now } = {}) {
  let inFlight = 0
  let lastEndedAt = -Infinity
  return {
    /** Runs `request`, marking the machine's work meanwhile as ours. */
    async around(request) {
      inFlight += 1
      try {
        return await request()
      } finally {
        inFlight -= 1
        lastEndedAt = clock()
      }
    },

    /** Did any of our requests run inside a sample window that began at `fromMs`? */
    overlaps(fromMs) {
      return inFlight > 0 || lastEndedAt >= fromMs
    },
  }
}

/**
 * Other people's cores, averaged over the last few samples.
 *
 * A single 2s sample over 0.5 cores used to mark the machine in use for ten
 * minutes, which assumed a quiet box sits at 0.07-0.20 cores. This one no
 * longer does: measured per process, qBittorrent (0.25), GNOME Shell (0.09),
 * another project's Docker dev stack (0.06) and the rest hold a floor of about
 * 0.45-0.6 cores with nobody doing anything, and spikes on top of it last one
 * sample -- so presence could never go quiet. Somebody working holds 1.36-1.94
 * cores, and a coding agent's job about a core on top of the floor. A short mean
 * against a line between the two (`CRAWL_ACTIVE_CORES` 1.0 over
 * `CRAWL_ACTIVE_WINDOW` 3 samples, 6s) keeps those and drops the spikes.
 */
export function createActivityWindow({ size = 3 } = {}) {
  const samples = []
  return {
    push(cores) {
      if (cores == null || !Number.isFinite(cores)) return
      samples.push(cores)
      if (samples.length > size) samples.shift()
    },
    mean() {
      if (samples.length < size) return null
      return samples.reduce((total, value) => total + value, 0) / samples.length
    },
  }
}
