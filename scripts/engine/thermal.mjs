/**
 * How much pool fits in the thermal headroom left on this machine?
 *
 * Every other guard in the controller measures *contention* -- the load
 * average, CPU pressure, cores used by everyone else. They all answer the same
 * question: is something else waiting for a core? On a desktop that is the
 * whole cost of a background crawl. On this laptop it is not, and the gap is
 * why a pool that every existing guard called "free" still made the machine
 * feel slow for thirty hours.
 *
 * `nice -n 19` decides *who* gets a core, never *how fast* that core runs. When
 * nothing else wants the CPU -- precisely the condition the other guards read
 * as safe -- one nice-19 engine runs a core at full boost indefinitely. On this
 * i7-1165G7, in a thin chassis, with PL1 held at 28W and no thermald, that
 * soaks the package to 90C. Package throttling is not per-process and does not
 * respect nice: every core drops, so the foreground work `nice 19` exists to
 * protect is throttled along with us.
 *
 * That inverts the whole protection model. The quieter the machine, the more
 * freely the crawler runs, and the hotter the package gets -- so by the time
 * somebody sits down, the chip is already at 90C with no headroom and their
 * very first keystroke is throttled. Meanwhile the contention guards all read
 * clean, because a single nice-19 process competes with nobody: PSI full sits
 * at 0.00 and other-cores near zero the entire time.
 *
 * The measurement that set ACTIVE_MAX=1 is not wrong, it is incomplete. One
 * engine really is free in scheduling terms (+5% on a foreground workload,
 * jitter identical to idle). One engine is also entirely sufficient to hold the
 * package at 88C forever, which costs every core 30% of its clock.
 *
 * So heat is sampled directly, as a fourth guard in the same shape as the other
 * three. Measured on this box:
 *
 *   crawler running, 1 engine     88-91C    30-82% of time throttled
 *   crawler stopped, 15-30s later 63-67C    ~0% (1-66ms per 15s)
 *   normal use, transient spikes  up to 83C no throttling
 *
 * The first version of this guard compared those bands against an *instant*
 * reading, and it starved the crawler to a standstill. The numbers above were
 * taken against a quiet desktop, and a desktop is not quiet. Re-measured with
 * the crawler fully stopped and a browser and a music player running -- the
 * machine's ordinary state -- the package alone swings:
 *
 *   64 90C over two minutes, 5 samples of 24 at or above 85C, median 76C
 *
 * So an instantaneous 85C trips on somebody scrolling a page, and a 75C floor
 * is the *median* of that trace: a gate open about half the time, slammed shut
 * again by the next render. The crawler sat at 0.00% CPU while 90% of the
 * machine was idle, because it was being charged for heat it did not produce.
 *
 * The fix is to filter the signal rather than move the thresholds. What
 * distinguishes the crawler from the browser is not how hot it gets but how
 * long it stays there: a render spikes for seconds, a crawl heat-soaks for
 * minutes. Averaging over `WINDOW` samples separates them cleanly -- across
 * that same ambient trace no 30s window averages above 83C, while a crawling
 * package holds 88-91C and averages straight through the trip point.
 *
 * Hence: trip on the mean, not the instant. 85C stays as the trip because it is
 * still the right *sustained* limit, and recovery moves to 80C, which the
 * smoothed signal reaches promptly without flapping now that single spikes
 * cannot reach it.
 */

// Samples averaged before the guard reacts. Six at the 5s poll is a 30s window:
// long enough that no browser transient in the measured ambient trace survives
// it, short enough that a genuine soak is caught well before it costs a minute
// of everyone's clock.
const WINDOW = 6

/**
 * A rolling mean of package temperature.
 *
 * The mean rather than the max, because the max is exactly the statistic that
 * made the first version unusable -- one spike in a window is indistinguishable
 * from a soak. The mean rather than the median, because a soak that is only
 * beginning should still register partially rather than being voted down by
 * older cool samples.
 *
 * Reports null until the window has filled, so a freshly started crawler judges
 * itself on a full window rather than on its first cool reading.
 */
export function createTempWindow({ size = WINDOW } = {}) {
  const samples = []
  return {
    push(tempC) {
      if (tempC == null || !Number.isFinite(tempC)) return
      samples.push(tempC)
      if (samples.length > size) samples.shift()
    },
    mean() {
      if (samples.length < size) return null
      return samples.reduce((total, value) => total + value, 0) / samples.length
    },
    /** For logging: what the guard is actually reacting to right now. */
    latest() {
      return samples.length ? samples[samples.length - 1] : null
    },
  }
}

// A CPU sensor reading outside this range is not a CPU sensor reading. The
// zones on this box include TCPU at -273C (unpopulated) and INT3400 at a flat
// 20C (a policy device, not a thermometer); taking a naive maximum or minimum
// across every zone picks one of those up and either never trips or never
// clears.
const PLAUSIBLE_MIN_C = 20
const PLAUSIBLE_MAX_C = 125

/** Celsius from a thermal_zone `temp` file, which reports millidegrees. */
export function parseZoneTemp(text) {
  const trimmed = String(text ?? '').trim()
  if (!/^-?\d+$/.test(trimmed)) return null
  const celsius = Number(trimmed) / 1000
  if (!Number.isFinite(celsius)) return null
  return celsius
}

/**
 * Package temperature from a set of `{ type, temp }` zone readings.
 *
 * `x86_pkg_temp` is the reading that governs package throttling, so it wins
 * outright when the kernel exposes it. Without it -- a different CPU vendor, a
 * kernel built without the driver -- the hottest plausible zone is the right
 * fallback: on this box SEN2 tracks the package within a degree, and being
 * slightly pessimistic about heat costs a little throughput, while being
 * optimistic costs the machine's owner their clock speed.
 *
 * Returns null when nothing plausible can be read, so the caller can fall back
 * to the contention guards rather than pinning the pool at zero on a machine
 * that simply has no thermometer.
 */
export function packageTempFrom(zones) {
  if (!Array.isArray(zones)) return null
  const readings = []
  for (const zone of zones) {
    const celsius = parseZoneTemp(zone?.temp)
    if (celsius == null) continue
    if (celsius < PLAUSIBLE_MIN_C || celsius > PLAUSIBLE_MAX_C) continue
    if (String(zone?.type ?? '').trim() === 'x86_pkg_temp') return celsius
    readings.push(celsius)
  }
  return readings.length ? Math.max(...readings) : null
}

/**
 * The pool ceiling implied by temperature, with hysteresis.
 *
 * Two thresholds rather than one, because a single one flaps: the pool stands
 * down at the trip point, the package cools a degree, the pool comes straight
 * back and reheats it, and the machine spends its life at exactly the
 * temperature that made it slow. Once hot, the crawler stays down until the
 * package has genuinely recovered to `coolC`.
 *
 * Hot means zero engines, not half of them. Heat is not shed by running a
 * smaller pool, only by leaving the cores alone long enough to dissipate what
 * is already there -- and with ACTIVE_MAX at 1 there is no smaller pool to fall
 * back to anyway. The 15-30s recovery measured on this box is what makes a full
 * stand-down affordable.
 *
 * The two directions read two different windows, and that asymmetry is
 * deliberate. `tempC` is the long (30s) mean, because the failure it guards
 * against is a *false hot*: this box's package spikes past 85C when somebody
 * scrolls a page, and one spike in a window must not stand the crawler down.
 * There is no matching false-cool to defend against -- a package reading 60C
 * is cool, and nothing transiently pretends to be. Charging recovery the same
 * 30 samples means the window has to flush every hot reading before the pool
 * may restart, so a package that fell from 85C to 66C in two seconds (measured
 * here) still waits out most of a 30s window. The crawler was idling at 55-62C
 * -- 20C below its own recovery threshold -- for about twenty seconds of every
 * cycle, which is the single largest piece of dead time in a crawl.
 *
 * So recovery reads `coolTempC`, a short (10s) mean: long enough that one
 * sample cannot restart the pool, short enough to notice a package that has
 * genuinely let go. Reheating is its own hysteresis -- the pool needs ~14s to
 * put the package back at the trip -- so this cannot produce a fast flap.
 * Omitting `coolTempC` falls back to `tempC` and the old symmetric behaviour.
 *
 * A null mean (window not yet full, or no sensor) runs on the contention
 * guards. `wasHot` is the caller's previous state; the returned `hot` replaces
 * it.
 */
export function thermalCeiling({
  tempC, coolTempC, hotC, coolC, wasHot = false, fullMax, active = 0, min = 1,
}) {
  // No thermometer: let the contention guards govern alone rather than refusing
  // to run forever on a machine we cannot measure.
  if (tempC == null || !Number.isFinite(tempC)) return { ceiling: fullMax, hot: false }
  // While hot, judge recovery on the short window when there is one. Falling
  // back to the long mean keeps a caller that passes neither exactly as it was.
  const recoveryTempC = coolTempC == null || !Number.isFinite(coolTempC) ? tempC : coolTempC
  const hot = wasHot ? recoveryTempC > coolC : tempC >= hotC
  if (hot) return { ceiling: 0, hot }
  // Cool enough to keep working, warm enough that there is nothing spare: hold
  // the pool where it is instead of adding to it.
  //
  // Without this the ceiling goes straight from 0 to the full pool, and on a
  // thermally limited box that sawtooths. One nice-19 engine alone holds this
  // package at 83-86C against a 54-60C idle, so the headroom for a second one
  // does not exist -- but the moment the guard releases, the load budget sees
  // seven idle cores and starts growing. The pool reaches two, heats twice as
  // fast, trips, stands down to zero, and comes back to one. That is the same
  // sawtooth the load guard grows one engine at a time to avoid, arriving by a
  // different road, and it trades working time for stand-down time.
  //
  // Growth is what gets held, never work already running: `min` still starts a
  // recovered pool, and a genuinely cool machine (a desktop with real cooling,
  // where the mean never reaches `coolC`) is unaffected and fills as before.
  if (tempC >= coolC) return { ceiling: Math.max(min, active), hot }
  return { ceiling: fullMax, hot }
}

/**
 * Read the package temperature from sysfs.
 *
 * `/sys/class/thermal` is not namespaced, so this reads the real host package
 * from inside the container -- the same reason `/proc/pressure` works there.
 * Every argument is injectable so the parsing above can be tested without a
 * sysfs, and any read error degrades to null rather than throwing into the
 * controller loop.
 */
export function readPackageTempC({ dir = '/sys/class/thermal', readdir, read } = {}) {
  try {
    const names = readdir(dir).filter(name => /^thermal_zone\d+$/.test(name))
    const zones = names.map(name => {
      try {
        return { type: read(`${dir}/${name}/type`), temp: read(`${dir}/${name}/temp`) }
      } catch {
        return null
      }
    }).filter(Boolean)
    return packageTempFrom(zones)
  } catch {
    return null
  }
}
