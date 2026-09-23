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
