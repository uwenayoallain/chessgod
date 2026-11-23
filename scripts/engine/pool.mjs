/**
 * How many engines the crawler should run right now.
 *
 * The crawler used to run a fixed pool and stand down entirely above
 * CRAWL_MAX_LOAD: three engines or nothing. That wastes an idle machine (the
 * pool never grows into free cores) and is rude on a busy one right up to the
 * cliff, where it stops dead instead of easing off.
 *
 * This grades the response instead. The load average is a whole-machine number
 * that already counts our own engines, so subtract what we contribute before
 * judging how busy the machine is -- otherwise a bigger pool reads as a busier
 * machine and throttles itself, which is backwards. What is left is other
 * people's work; whatever remains of the CRAWL_MAX_LOAD budget is ours.
 *
 * `ourRecentWorkers` is the *largest* pool we have run recently rather than the
 * one running now, because loadavg is a one-minute average and lags a resize.
 * Subtracting the current (smaller) size right after shrinking would leave our
 * own decaying load looking like someone else's and ratchet the pool down and
 * keep it there.
 */
export function targetWorkers({
  loadavg1,
  cores,
  ourRecentWorkers,
  threads = 1,
  maxLoad,
  min,
  max,
}) {
  const otherLoad = Math.max(0, loadavg1 - ourRecentWorkers * threads)
  const freeCores = cores * maxLoad - otherLoad
  // Not even one engine fits inside the budget: yield the machine completely.
  if (freeCores < threads) return 0
  return Math.min(max, Math.max(min, Math.floor(freeCores / threads)))
}

/**
 * The largest pool size still counted in the load average.
 *
 * Keeps sizes seen within `windowMs` (loadavg's own averaging window) so a
 * shrink does not immediately mistake our own decaying load for other work.
 */
export function createLoadHistory({ windowMs = 60_000, now = Date.now } = {}) {
  let entries = []
  return {
    record(workers) {
      entries.push({ workers, at: now() })
    },
    recentMax(current) {
      const cutoff = now() - windowMs
      entries = entries.filter(entry => entry.at >= cutoff)
      return Math.max(current, ...entries.map(entry => entry.workers), 0)
    },
  }
}

/**
 * The pool size to actually move to, given where it is and where it wants to be.
 *
 * Jumping straight to the target oscillates, and the oscillation is what a
 * person at the keyboard actually feels. Observed while the machine's owner had
 * a browser open: 3->5 at load 3.49, 5->4 at 5.75, stand down at 8.67, back to
 * 5 at 4.54, stand down at 8.63, 5->1 at 9.60 -- a sawtooth that never settles,
 * because five engines are enough to drive the load that stands them down, and
 * the moment they stop the load falls far enough to invite all five back.
 *
 * So: shrink to the target at once, but grow by a single engine and only after
 * the headroom has survived `growPatience` consecutive checks. Each step then
 * gets a full load-average window to show its cost before the next one is
 * added, which is what stops the overshoot. An idle machine still reaches the
 * ceiling, just over a few batches instead of in one leap.
 *
 * Note that `nice` does not make this unnecessary. It orders CPU *scheduling*;
 * it does nothing about the L3 cache and memory bandwidth these engines
 * saturate, which is what a browser notices.
 */
export function nextWorkers({
  active, target, quietStreak, growPatience = 2, msSinceGrowth = Infinity, growIntervalMs = 45_000,
}) {
  if (target <= active) return target
  // Coming back from a standstill is not an overshoot risk: a stopped pool
  // contributes no load at all, and the budget has already said at least one
  // engine fits. Making the first engine wait for patience just leaves the
  // crawler idle for two rounds every time it resumes.
  if (active === 0) return 1
  // Patience has to be counted in *time*, not batches. A batch is only as long
  // as the pool running it: at one engine it is a handful of positions and can
  // finish in seconds, so "two batches" once let the pool go 1->2->3->4->5 in
  // fifty-one seconds -- with three seconds between the first two steps. The
  // whole point is to give each added engine a load-average window to show its
  // cost, and the load average is a one-minute average, so the wait must be on
  // that scale whatever the batch happens to be.
  if (msSinceGrowth < growIntervalMs) return active
  return quietStreak >= growPatience ? active + 1 : active
}

/**
 * Parse CPU pressure (PSI) out of /proc/pressure/cpu.
 *
 * `some avg10` is the share of the last ten seconds in which at least one task
 * was runnable but waiting for a CPU. That is a far better "is a person waiting
 * on this machine" signal than the load average: loadavg is a one-minute
 * average, so the pool keeps its full size for about a minute after someone
 * starts working, which is exactly the window they notice. Returns null when
 * the file is missing or unreadable (non-Linux, older kernels, PSI disabled),
 * in which case the caller simply keeps using the load budget alone.
 */
export function parseCpuPressure(text) {
  const match = /^some\b.*?\bavg10=([0-9.]+)/m.exec(text ?? '')
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/**
 * Shrink hard when tasks are actually stalling for CPU.
 *
 * Only ever reduces: pressure is a reason to get out of the way, never a reason
 * to grow, and growth stays governed by the load budget plus its patience. The
 * cut is multiplicative so that relief is immediate rather than one engine per
 * batch -- the machine's owner should not have to wait out four more batches.
 */
export function pressureLimit({ active, pressure, maxPressure, min = 1 }) {
  if (pressure == null || pressure <= maxPressure) return active
  return Math.max(min, Math.floor(active / 2))
}
