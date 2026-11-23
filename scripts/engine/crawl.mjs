/**
 * A deliberately slow, resource-bounded background crawler.
 *
 * The browser crawl only runs while a tab is open and manages about ten
 * positions a minute; a library of this size needs hundreds of hours of that.
 * This does the same job headless, from the same Stockfish 19 build the browser
 * loads (`sf19.mjs`), so the rows it stores satisfy the engine contract
 * honestly rather than being a second engine's opinion.
 *
 * The host is a shared machine, so the machine's owner always wins -- but an
 * idle machine is not a shared one, and the crawler now says so:
 *
 *  - the pool is a range, not a number. Before every batch it sizes itself to
 *    whatever is left of the CRAWL_MAX_LOAD budget after other people's work,
 *    between CRAWL_WORKERS_MIN and CRAWL_WORKERS_MAX. An idle box gets filled;
 *    a busy one gets one engine; a very busy one gets none. The old guard ran a
 *    fixed pool and then stopped dead at a cliff, which both wasted an idle
 *    machine and was rude right up to the edge;
 *  - one engine thread each, because separate positions parallelise and
 *    Stockfish's shared search tree does not;
 *  - it pauses between positions (CRAWL_REST_MS) so it never saturates a core;
 *  - it watches the package temperature and stands down entirely above
 *    CRAWL_HOT_C until it falls back to CRAWL_COOL_C. The guards above all
 *    measure *contention*, and a single nice-19 engine contends with nobody --
 *    so on a thin laptop they stay clean while the package heat-soaks to 90C
 *    and throttling takes 30% of the clock off every core, including whatever
 *    the machine's owner is doing. `nice` cannot help: it picks who gets a
 *    core, never how fast that core runs. See `thermal.mjs`;
 *  - it takes work from the same queue endpoint the browser uses, so it
 *    inherits the phase rotation and the clock-ordered post-opening queue, and
 *    uploads through the same endpoint, so dedup and cache invalidation are
 *    unchanged.
 *
 * Run it with `nice` (the Makefile target and compose service both do).
 */

import os from 'node:os'
import { readFileSync, readdirSync } from 'node:fs'
import { createEngine } from './sf19.mjs'
import { requestJson } from './http.mjs'
import { createOutage, formatDuration } from './outage.mjs'
import { createIdleWait } from './idle.mjs'
import { createSetAside } from './setaside.mjs'
import { uploadEvaluations, uploadWithRetry } from './upload.mjs'
import {
  targetWorkers, createLoadHistory, nextWorkers, parseCpuPressure, pressureLimit,
} from './pool.mjs'
import {
  parseProcStat, parseCgroupUsage, otherCoresBetween, presenceCeiling, createOwnWork,
  createActivityWindow,
} from './presence.mjs'
import { readPackageTempC, thermalCeiling, createTempWindow } from './thermal.mjs'

const API = process.env.CRAWL_API ?? 'http://localhost:18000'
const USERNAME = process.env.CRAWL_USERNAME
const TIME_CLASS = process.env.CRAWL_TIME_CLASS ?? 'rapid_blitz'
// Not a constant: the server owns the depth a crawl fills to and reports it as
// `review_depth`. Picking a number here is how this crawler first filled 69
// positions at depth 18 while the browser was filling at 22 — deep enough to be
// stored, too shallow for the browser's coverage query to count, and four plies
// from its partners, which is past MAX_PAIR_DEPTH_GAP, so none of it could
// grade anything. CRAWL_MIN_DEPTH overrides only if you mean to.
const MIN_DEPTH_OVERRIDE = process.env.CRAWL_MIN_DEPTH
  ? Number(process.env.CRAWL_MIN_DEPTH)
  : null
let minDepth = MIN_DEPTH_OVERRIDE ?? 22
// The batch a *full* pool takes. What each batch actually asks for scales with
// the pool that is running, so a batch takes roughly the same wall time whatever
// the size -- a whole number of rounds, with no engine idle on the last one.
//
// A fixed count is worse than it looks, because the pool can only resize between
// batches: at one engine a flat 24 positions takes about ten minutes, so growing
// back to five would have taken the best part of an hour, and the crawler sat at
// one engine on an idle machine. Scaling keeps the resize cadence constant.
const BATCH = Number(process.env.CRAWL_BATCH ?? 24)
// Positions are independent, so the way to use more of the machine is more
// engines rather than more threads inside one search. Re-measured over 86 real
// library positions at depth 22, each config in a fresh process after a
// warm-up, with the container's CPU cap lifted, in positions/min:
//
//     engines:  1  13.3   2  28.3   3  39.2   4  48.3   5  54.4   6  51.4
//     threads on one engine:  1  16.7   2  21.8   4  12.8
//
// Five engines is the knee on this box (4 physical cores, 8 logical); a sixth
// regresses. An earlier measurement put the knee at three, but it was taken
// inside a container capped at 2.0 cores and was measuring the cap, not the
// engine: nothing above two cores of demand could show a difference. Stockfish's
// own parallel search shares a tree and scales far worse than separate
// positions do, which is why threads-per-engine stays at one.
//
// The pool is a range rather than a number: see `targetWorkers`. CRAWL_WORKERS
// is kept as an alias for the ceiling so an existing pinned setting still means
// "never more than this".
const WORKERS_MAX = Math.max(1, Number(process.env.CRAWL_WORKERS_MAX ?? process.env.CRAWL_WORKERS ?? 5))
const WORKERS_MIN = Math.max(1, Math.min(WORKERS_MAX, Number(process.env.CRAWL_WORKERS_MIN ?? 1)))
// Declared here rather than beside BATCH: it reads WORKERS_MAX, which is
// defined above this line and below that one.
const ROUNDS_PER_BATCH = Math.max(1, Math.ceil(BATCH / WORKERS_MAX))
const batchSize = () => (active > 0 ? active * ROUNDS_PER_BATCH : BATCH)
const THREADS = Number(process.env.CRAWL_THREADS ?? 1)
// Per engine, so the total is WORKERS x this. Kept modest because separate
// positions share almost nothing through a transposition table anyway.
const HASH_MB = Number(process.env.CRAWL_HASH_MB ?? 96)
// Load average per core above which the crawler stands down. 0.7 leaves clear
// headroom on a machine that is otherwise idle but yields as soon as anything
// else wants the CPU.
const MAX_LOAD = Number(process.env.CRAWL_MAX_LOAD ?? 0.7)
// Consecutive batches of headroom required before adding one more engine. The
// pool shrinks at once but grows a step at a time, so each added engine gets a
// load-average window to show its cost before the next. Without it the pool
// sawtooths between the ceiling and standing down, which is the pattern a
// person at the keyboard actually feels -- see `nextWorkers`.
const GROW_PATIENCE = Number(process.env.CRAWL_GROW_PATIENCE ?? 2)
// Minimum wall-clock gap between adding engines. Patience counted in batches is
// not patience at all: a batch is only as long as the pool running it, so at one
// engine it can finish in seconds and the pool went 1->2->3->4->5 in fifty-one
// seconds. The load average this is all judged against is a one-minute average,
// so the wait has to be on that scale.
const GROW_INTERVAL_MS = Number(process.env.CRAWL_GROW_INTERVAL_MS ?? 45_000)
// How often to re-check CPU pressure *during* a batch. Between batches is too
// late: at five engines a batch runs 30-60s, and that is the whole reaction time
// someone at the keyboard experiences. Engines past the cut finish the position
// in hand and then stop taking new ones.
const PRESSURE_POLL_MS = Number(process.env.CRAWL_PRESSURE_POLL_MS ?? 5_000)
// Presence gating. Load average and CPU pressure are both *reactive* -- they
// only rise once the crawler is already competing with the person using the
// machine, so relief always arrives after they have felt it. These cap the pool
// while somebody is there at all, so the surge is never produced in the first
// place.
//
// Cores of non-crawler CPU, averaged over ACTIVE_WINDOW samples, that count as
// "somebody is using this machine". 0.5 was chosen against a quiet box at
// 0.07-0.20 cores; this one now idles at 0.45-0.6 (qBittorrent, GNOME Shell,
// another project's Docker dev stack) with one-sample spikes past a core, so a
// single sample over 0.5 held it "in use" around the clock. Somebody working
// holds 1.36-1.94, and an agent's job about a core over the floor, so 1.0 over
// a 6s mean sits between them. See `createActivityWindow`. Our own backend and
// Postgres are excluded outright (`createOwnWork`), not averaged away.
const ACTIVE_CORES = Number(process.env.CRAWL_ACTIVE_CORES ?? 1.0)
const ACTIVE_WINDOW = Math.max(1, Number(process.env.CRAWL_ACTIVE_WINDOW ?? 3))
// How long the machine must stay quiet before the full pool is allowed.
const IDLE_AFTER_MS = Number(process.env.CRAWL_IDLE_AFTER_MS ?? 10 * 60_000)
// The ceiling while somebody is present, chosen by measurement rather than by
// how cautious the last complaint made us feel.
//
// Measured on this box against a fixed single-threaded foreground workload and a
// 10ms timer (the jitter a video call actually cares about), while the pool ran
// real library positions:
//
//   engines   foreground      vs idle   jitter p99   jitter max
//     0        153ms            --        0.34ms       0.61ms
//     1        161ms           +5%        0.42ms       0.61ms
//     2        179ms          +17%        0.77ms       2.59ms
//     3        175ms          +14%        0.28ms       3.45ms
//     5        227ms          +48%        2.04ms       4.05ms
//
// One engine is free: +5% is inside the run-to-run spread, and jitter is
// identical to an idle machine at every percentile. Five is what makes the
// machine feel slow -- everything foreground takes half as long again. So one
// engine keeps working while its owner does, and the difference between them is
// where the whole cost lives.
//
// Set 0 to pause outright while the machine is in use.
const ACTIVE_MAX = Math.max(0, Number(process.env.CRAWL_ACTIVE_MAX ?? 1))
// How often presence is sampled, during batches as well as between them.
const PRESENCE_POLL_MS = Number(process.env.CRAWL_PRESENCE_POLL_MS ?? 2_000)
// CPU pressure (PSI) above which the pool is halved on the spot, as a percentage
// of the last ten seconds in which some task was runnable but waiting for a CPU.
// The load average cannot do this job: it is a one-minute average, so the pool
// keeps its full size for about a minute after someone starts working, which is
// precisely the window they feel. Measured on this box: five engines on an
// otherwise idle machine sit at 0.75-1.7%, because eight logical cores absorb
// them, while the reading taken when the machine's owner reported real lag was
// 27%. 10 sits clearly above the idle noise and well below the painful end, so
// it costs nothing on an idle box but trips before a person is kept waiting.
const MAX_PRESSURE = Number(process.env.CRAWL_MAX_PRESSURE ?? 10)
// Thermal gating. The guards above all measure contention, and a single
// nice-19 engine contends with nobody -- so on this laptop they read clean
// while the package sits at 90C and throttling takes 30% of the clock off every
// core, the machine's owner included. See `thermal.mjs` for why nice cannot
// help here and for the measurements these two numbers sit between: 63-67C
// crawler-stopped baseline, spikes to 83C in ordinary use, 88-91C and
// throttling with the crawler running.
const HOT_C = Number(process.env.CRAWL_HOT_C ?? 85)
// Recovery sits 5C below the trip rather than down at the idle baseline. A
// floor of 75C was the *median* of this machine's ambient trace with a browser
// and a music player running, so the crawler spent its life waiting for a
// temperature that arrives half the time and leaves on the next page render.
// Nothing needs that much margin now that the guard reacts to a 30s mean
// instead of an instant reading -- see `thermal.mjs`.
const COOL_C = Number(process.env.CRAWL_COOL_C ?? 80)
// The same pair, for while somebody is actually at the machine.
//
// 85C is the right *unattended* limit -- measured on this box, package
// throttling starts around 83-85C, so it puts the crawler exactly as close to
// the hardware's own limit as it can get without paying for it. It is the
// wrong limit to hand a person, because it leaves them none of the headroom:
// arriving at a package already soaked to 85C, their first real work pushes
// straight into throttling, and the trip is judged on a 30s mean so the
// crawler needs up to half a minute to notice and get out of the way.
//
// Dropping the threshold instead of waiting for the mean to climb means
// presence itself moves the line: the presence sampler runs every 2s, so the
// moment somebody shows up the package is already over the active trip and
// the pool stands down on the next poll rather than 30s later. The crawler
// gives its thermal headroom to the person the way it already gives up its
// cores to them.
//
// 80C sits above this machine's quiet-desktop band (54-60C idle, ~65-70C
// reading) so light use does not stop the crawl, and below the 83C that the
// measured ambient trace reaches under real work. Set them equal to HOT_C and
// COOL_C to go back to one threshold for both.
const HOT_ACTIVE_C = Number(process.env.CRAWL_HOT_ACTIVE_C ?? 80)
const COOL_ACTIVE_C = Number(process.env.CRAWL_COOL_ACTIVE_C ?? 75)
// Heat builds over seconds, not minutes, and the package cools back in 15-30s,
// so this is polled on the presence clock rather than the batch one.
const THERMAL_POLL_MS = Number(process.env.CRAWL_THERMAL_POLL_MS ?? 5_000)
// Samples averaged before the guard will call the package cool again. Two at
// the 5s poll is a 10s window against the trip's 30s, and the asymmetry is the
// point: the long window defends against a false hot, and nothing produces a
// false cool. Measured here, the package drops from 85C to 66C within two
// seconds of the pool stopping, so judging recovery on 30s of history left the
// crawler standing at 55-62C -- 20C below its own threshold -- for about
// twenty seconds per cycle. See `thermalCeiling`.
const COOL_WINDOW = Math.max(1, Number(process.env.CRAWL_COOL_WINDOW ?? 2))
// A breather between positions so a pool never pins its cores solid. Small,
// because standing down for other work is the load guard's job, not this one's.
const REST_MS = Number(process.env.CRAWL_REST_MS ?? 100)
const IDLE_MS = Number(process.env.CRAWL_IDLE_MS ?? 60_000)
// The ceiling an unchanged empty queue's wait doubles up to (idle.mjs).
const IDLE_MAX_MS = Number(process.env.CRAWL_IDLE_MAX_MS ?? 30 * 60_000)
const BUSY_MS = Number(process.env.CRAWL_BUSY_MS ?? 30_000)
// How often a standing-down crawler re-checks whether it may start again.
// This used to be BUSY_MS, which is a queue-outage backoff and far too coarse
// for the thing it was actually gating: the package recovers in well under ten
// seconds, so a 30s re-check spent on average fifteen of them idle on a machine
// that was already cool and free. The check itself is three reads of state the
// samplers refresh anyway, so it costs nothing to do it on their clock.
const RECHECK_MS = Number(process.env.CRAWL_RECHECK_MS ?? 2_000)
// Stopping after this many batches that queued nothing mirrors the browser
// crawl: if the server keeps offering work the engine cannot turn into new
// rows, something is wrong and spinning forever hides it.
const MAX_IDLE_BATCHES = Number(process.env.CRAWL_MAX_IDLE_BATCHES ?? 5)
// How long to wait out a stall before looking for work again, and the ceiling
// on the upload retry backoff. Neither ends the run.
const IDLE_STALL_MS = Number(process.env.CRAWL_IDLE_STALL_MS ?? 600_000)
const UPLOAD_RETRY_MAX_MS = Number(process.env.CRAWL_UPLOAD_RETRY_MAX_MS ?? 300_000)
// Ceiling on the queue-outage backoff. A backend restart is back inside a
// minute or two; an outage longer than that is someone's attention, not the
// crawler's, and polling it every BUSY_MS just buries the log.
const QUEUE_RETRY_MAX_MS = Number(process.env.CRAWL_QUEUE_RETRY_MAX_MS ?? 300_000)
// How long a queue request may take. The shared 30s default read a healthy
// backend as a failing one: when the queue's pool expires the request that
// finds it rebuilds it, which takes ~3s on a quiet machine and 12s at load 5-9,
// and past 30s at load 10+ -- measured overnight, with another project's jobs
// saturating the box, six requests timed out and each cost 2-4 minutes of
// backoff for work that was about to arrive. A slow answer is still an answer.
const QUEUE_TIMEOUT_MS = Number(process.env.CRAWL_QUEUE_TIMEOUT_MS ?? 120_000)

if (!USERNAME) {
  console.error('CRAWL_USERNAME is required')
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const CORES = Math.max(os.cpus().length, 1)
// The largest pool we have run inside the load average's own window, so a
// shrink is not mistaken for someone else's work. See `createLoadHistory`.
const loadHistory = createLoadHistory()

// How many engines to run for the next batch. Grows into an idle machine and
// eases off a busy one instead of the old all-or-nothing guard, which ran a
// fixed pool until load crossed a cliff and then stopped dead.
// Reads the host's PSI, which is visible inside the container because
// /proc/pressure is not namespaced. Null on any machine that cannot report it,
// and the load budget then governs alone.
function cpuPressure() {
  try {
    return parseCpuPressure(readFileSync('/proc/pressure/cpu', 'utf8'))
  } catch {
    return null
  }
}

// --- heat -----------------------------------------------------------------
// Sampled on its own clock like presence, so the ceiling is current whether or
// not a batch is in flight, and cached rather than re-read on every call: a
// sysfs walk per engine per resize is a lot of syscalls for a number that moves
// on a thermal time constant.
let thermallyHot = false
let lastTempC = null
let lastCoolTempC = null
// The guard judges a rolling mean, never the instant reading: this machine's
// package swings 64-90C with nothing but a browser open, so an instant 85C is a
// reading of somebody scrolling, not of anything the crawler did.
const tempWindow = createTempWindow()
// Recovery reads its own, shorter window. The long one exists to survive a
// false *hot*; there is no false cool, and making the pool wait out 30s of
// history before restarting left it idling at 55-62C, far below the threshold
// it was waiting for. See `thermalCeiling`.
const coolWindow = createTempWindow({ size: COOL_WINDOW })

function packageTemp() {
  return readPackageTempC({ readdir: readdirSync, read: path => readFileSync(path, 'utf8') })
}

/**
 * The trip and recovery pair in force right now.
 *
 * Reads `machineInUse`, which is declared further down with the rest of the
 * presence state -- which is why the thermal sampler is started down there too
 * rather than here.
 */
function thermalThresholds() {
  return machineInUse()
    ? { hotC: HOT_ACTIVE_C, coolC: COOL_ACTIVE_C }
    : { hotC: HOT_C, coolC: COOL_C }
}

function sampleThermal() {
  const reading = packageTemp()
  tempWindow.push(reading)
  coolWindow.push(reading)
  lastTempC = tempWindow.mean()
  lastCoolTempC = coolWindow.mean()
  const { hotC, coolC } = thermalThresholds()
  const { hot } = thermalCeiling({
    tempC: lastTempC, coolTempC: lastCoolTempC,
    hotC, coolC, wasHot: thermallyHot, fullMax: WORKERS_MAX,
  })
  // Both edges are logged. A crawler that silently stops for an hour looks
  // exactly like a crawler that crashed, and this is now the most likely reason
  // for a long quiet stretch in a multi-day run.
  if (hot && !thermallyHot) {
    log(`package averaging ${lastTempC.toFixed(0)}C over ${hotC}C` +
        `${machineInUse() ? ' (machine in use)' : ''}, ` +
        `standing down until it falls to ${coolC}C`)
  } else if (!hot && thermallyHot) {
    log(`package averaging ${(lastCoolTempC ?? lastTempC).toFixed(0)}C, resuming`)
  }
  thermallyHot = hot
}

/**
 * The pool ceiling heat currently allows.
 *
 * `active` is what is running now: inside the warm band the guard holds the
 * pool at that rather than releasing the whole thing back to the load budget.
 */
function thermalLimit(active = 0) {
  const { hotC, coolC } = thermalThresholds()
  return thermalCeiling({
    tempC: lastTempC, coolTempC: lastCoolTempC,
    hotC, coolC, wasHot: thermallyHot, fullMax: WORKERS_MAX,
    active, min: WORKERS_MIN,
  }).ceiling
}

// Started below, after the presence state it reads has been declared.

// --- presence -------------------------------------------------------------
// One sampler, running for the life of the process, so the ceiling is current
// whether or not a batch happens to be in flight.
let presenceSample = null
let lastActiveAt = Date.now()
let lastOtherCores = null
// Our own requests: the backend and Postgres work they cause is not a person.
// See `createOwnWork`.
const ownWork = createOwnWork()
const activity = createActivityWindow({ size: ACTIVE_WINDOW })
// What presence last told the log, so a change of state is written once.
let reportedInUse = null

function readPresenceSample() {
  try {
    const stat = parseProcStat(readFileSync('/proc/stat', 'utf8'))
    const ours = parseCgroupUsage(readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'))
    if (!stat || ours == null) return null
    return { busy: stat.busy, ours, at: Date.now() }
  } catch {
    return null
  }
}

function samplePresence() {
  const next = readPresenceSample()
  const windowStart = presenceSample?.at
  const other = otherCoresBetween(presenceSample, next)
  if (next) presenceSample = next
  // Unmeasurable, or measuring our own backend: leave the belief alone.
  if (other != null && !(windowStart != null && ownWork.overlaps(windowStart))) {
    lastOtherCores = other
    activity.push(other)
    if ((activity.mean() ?? 0) >= ACTIVE_CORES) lastActiveAt = Date.now()
  }
  // Written on change only. This is the state the thermal line and the pool
  // ceiling both hang on, and it was misread for days without the log ever
  // saying which way it had gone.
  const inUse = machineInUse()
  if (inUse !== reportedInUse) {
    if (reportedInUse !== null || inUse) {
      log(inUse
        ? `machine in use (${activity.mean() == null ? 'assumed at start' : `${activity.mean().toFixed(2)} cores of other work`}): ` +
          `at most ${ACTIVE_MAX} engine(s), thermal line ${HOT_ACTIVE_C}C`
        : `machine quiet for ${Math.round(IDLE_AFTER_MS / 60000)}min: ` +
          `up to ${WORKERS_MAX} engine(s), thermal line ${HOT_C}C`)
    }
    reportedInUse = inUse
  }
}

/**
 * Is somebody using the machine right now?
 *
 * The same window the pool ceiling uses, so presence means one thing across
 * both guards: still "in use" for IDLE_AFTER_MS after the last busy sample,
 * because a person who paused for a moment has not left.
 */
function machineInUse() {
  if (presenceSample == null && lastOtherCores == null) return false
  return Date.now() - lastActiveAt < IDLE_AFTER_MS
}

/** The pool ceiling presence currently allows. */
function presenceLimit() {
  // Unmeasurable machine (no cgroup v2, no /proc/stat): fall back to the load
  // budget alone rather than pinning the pool at the active cap forever.
  if (presenceSample == null && lastOtherCores == null) return WORKERS_MAX
  return presenceCeiling({
    msSinceActive: Date.now() - lastActiveAt,
    idleAfterMs: IDLE_AFTER_MS,
    activeMax: ACTIVE_MAX,
    fullMax: WORKERS_MAX,
  })
}

presenceSample = readPresenceSample()
const presenceTimer = setInterval(samplePresence, PRESENCE_POLL_MS)
presenceTimer.unref?.()

// Thermal sampling starts here rather than beside its own code: the trip it
// applies depends on whether anybody is here, so it reads the presence state
// declared above and would hit the temporal dead zone if it ran any earlier.
sampleThermal()
const thermalTimer = setInterval(sampleThermal, THERMAL_POLL_MS)
thermalTimer.unref?.()

function chooseWorkers(active) {
  return Math.min(presenceLimit(), thermalLimit(active), targetWorkers({
    loadavg1: os.loadavg()[0],
    cores: CORES,
    ourRecentWorkers: loadHistory.recentMax(active),
    threads: THREADS,
    maxLoad: MAX_LOAD,
    min: WORKERS_MIN,
    max: WORKERS_MAX,
  }))
}
const log = (...parts) => console.log(new Date().toISOString(), ...parts)

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`${signal} received, finishing the current position`)
    stopping = true
  })
}

// Wait until at least one engine fits inside the load budget, and report how
// many do. Zero means the machine is busy enough that we yield it completely.
let standingDown = false
async function waitForCapacity(active) {
  for (;;) {
    if (stopping) return 0
    const target = chooseWorkers(active)
    if (target > 0) {
      if (standingDown) log(`machine free again, resuming`)
      standingDown = false
      return target
    }
    const why = thermalLimit(active) === 0
      ? `package ${(lastTempC ?? 0).toFixed(0)}C, waiting for ${thermalThresholds().coolC}C`
      : presenceLimit() === 0
        ? `machine in use (${(lastOtherCores ?? 0).toFixed(2)} cores of other work)`
        : `load ${os.loadavg()[0].toFixed(2)} over ${CORES} cores leaves no room`
    // Only on the way in. A paused crawler is the normal state now, and a line
    // every BUSY_MS would bury the batches that matter in a multi-day run.
    if (!standingDown) log(`${why}, standing down until the machine is free`)
    standingDown = true
    await sleep(RECHECK_MS)
  }
}

// Positions this process could not finish. The queue keeps offering a position
// until it is analysed, so without telling it, a search we cannot complete is
// re-offered every batch forever: one depth-34 job burned the whole deadline on
// every batch, costing about 40% of an engine and stretching batches from ~45s
// to three minutes. The endpoint takes these as selection context, exactly as
// the browser crawl reports its own timeouts, never as completed work.
//
// Held back for a while, not for good: a set that lasted the whole process
// grew to thirteen positions over three days, and once those were the queue's
// newest work a one-engine crawl got an empty batch every minute for thirty
// hours. See setaside.mjs for the backoff.
const unfinished = createSetAside({
  baseMs: Number(process.env.CRAWL_RETRY_UNFINISHED_MS ?? 6 * 3_600_000),
  maxMs: Number(process.env.CRAWL_RETRY_UNFINISHED_MAX_MS ?? 48 * 3_600_000),
})
// Evaluations the server refused to store. Like `unfinished`, these are
// selection context rather than completed work: without saying so, the queue
// re-offers a position until it is analysed, and one that can never validate
// would otherwise be re-searched every batch forever — an engine search plus
// two uploads per batch, each batch. Seen in the wild: stale castling rights
// the engine searches fine and the server's own validator rejects. The queue
// no longer offers those, so this set is normally empty; it is the defence
// for whatever the next un-storable shape turns out to be.
const rejected = new Set()
// The endpoint accepts at most this many exclusions per request.
const EXCLUDE_LIMIT = 512

// Is the backend itself there? The crawler cannot start it -- it has no docker
// socket, and giving it one would hand a background job root on the host -- but
// it can say which of the two failures this is, which is the difference between
// "restart the backend" and "look at the queue endpoint". compose keeps the
// backend running (`restart: unless-stopped`) and holds the crawler until it is
// healthy (`depends_on: condition: service_healthy`); this probe is what makes
// the log say so when that is not enough.
async function probeBackend() {
  try {
    await ownWork.around(() => requestJson(new URL('/api/health', API), { timeoutMs: 5_000 }))
    return 'up'
  } catch (error) {
    // A refused connection, a DNS failure or a timeout is the backend being
    // absent. Any HTTP answer at all means something is listening, so the
    // backend is not what needs restarting.
    return error.status ? 'up' : 'down'
  }
}

// One continuous outage of the queue: backs the retry off to CRAWL_QUEUE_RETRY_MAX_MS
// and makes each line state the outage rather than repeat during it.
const outage = createOutage({ baseMs: BUSY_MS, maxMs: QUEUE_RETRY_MAX_MS })
const idleWait = createIdleWait({ baseMs: IDLE_MS, maxMs: IDLE_MAX_MS })

async function fetchBatch() {
  const url = new URL('/api/games/unanalyzed-fens', API)
  url.searchParams.set('username', USERNAME)
  url.searchParams.set('time_class', TIME_CLASS)
  url.searchParams.set('min_depth', String(minDepth))
  url.searchParams.set('limit', String(batchSize()))
  // Rows are stored per depth, so a side studied deep on the board is searched
  // again at the review depth rather than its partner at 34 (see _pair_work).
  url.searchParams.set('shallow_pairs', 'true')
  const excluded = [...unfinished.excluded(), ...rejected]
  if (excluded.length === 0) return ownWork.around(() => requestJson(url, { timeoutMs: QUEUE_TIMEOUT_MS }))
  return ownWork.around(() => requestJson(url, {
    timeoutMs: QUEUE_TIMEOUT_MS,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Keep the most recent failures when there are more than the cap allows.
    body: JSON.stringify({ exclude_fens: excluded.slice(-EXCLUDE_LIMIT) }),
  }))
}

async function upload(items) {
  return ownWork.around(() => uploadEvaluations(API, items, {
    onRejected: (invalid, details) => {
      for (const item of invalid) rejected.add(item.fen)
      const reasons = [...new Set(details.map(issue => issue.msg ?? issue.type ?? "unspecified validation error"))]
      log(`validation rejected ${invalid.length} evaluations: ${reasons.join("; ")}; excluding these positions and preserving the rest of the batch`)
    },
  }))
}

// Engines are created on demand and then kept. Growing means starting one more
// (a few seconds of WASM and network load, paid once); shrinking means simply
// not handing work to the tail of the pool. A parked engine costs its hash
// table and wasm heap -- about 450MB -- and no CPU at all, which is why the
// ceiling is bounded by CRAWL_MEMORY rather than by the load budget. Tearing
// engines down instead is not an option worth taking: the Stockfish build
// exposes no shutdown, and `quit` on a wasm module aborts it.
const pool = []
async function poolOf(size) {
  while (pool.length < size) {
    pool.push(await createEngine({ threads: THREADS, hash: HASH_MB }))
  }
  return pool.slice(0, size)
}

log(`crawling for ${USERNAME}: ${WORKERS_MIN}-${WORKERS_MAX} engine(s) x ${THREADS} thread, ` +
    `${HASH_MB}MB hash each, ${CORES} cores, under ${MAX_LOAD} load/core`)
log(`while the machine is in use: at most ${ACTIVE_MAX} engine(s) ` +
    `(over ${ACTIVE_CORES} cores of other work across ${ACTIVE_WINDOW * PRESENCE_POLL_MS / 1000}s counts as in use); ` +
    `full pool after ${Math.round(IDLE_AFTER_MS / 60000)}min quiet`)

let idleBatches = 0
let totalStored = 0
let active = 0
let quietStreak = 0
let lastGrowthAt = 0
while (!stopping) {
  const target = await waitForCapacity(active)
  if (stopping) break
  quietStreak = target > active ? quietStreak + 1 : 0
  // Pressure only ever cuts, and it cuts before patience is consulted: getting
  // out of someone's way is not something to be patient about.
  const pressure = cpuPressure()
  const relieved = pressureLimit({ active, pressure, maxPressure: MAX_PRESSURE, min: WORKERS_MIN })
  if (relieved < active) {
    log(`cpu pressure ${pressure.toFixed(1)}% over ${MAX_PRESSURE}%, pool ${active} -> ${relieved} engine(s)`)
    active = relieved
    quietStreak = 0
  }
  const next = nextWorkers({
    active, target, quietStreak,
    growPatience: GROW_PATIENCE,
    msSinceGrowth: Date.now() - lastGrowthAt,
    growIntervalMs: GROW_INTERVAL_MS,
  })
  if (next !== active) {
    log(`pool ${active} -> ${next} engine(s) (want ${target}, load ${os.loadavg()[0].toFixed(2)} over ${CORES} cores)`)
    if (next > active) lastGrowthAt = Date.now()
    active = next
    if (next >= target) quietStreak = 0
  }
  if (active === 0) {
    // Nothing to search with. Fetching anyway burns a queue request and books
    // an empty batch against MAX_IDLE_BATCHES, which is how a stand-down used
    // to look like "the server keeps offering work we cannot use".
    await sleep(BUSY_MS)
    continue
  }

  let batch
  try {
    batch = await fetchBatch()
    // Adopt the server's review depth the first time we see it, so the two
    // crawls cannot fill the library to different standards.
    if (MIN_DEPTH_OVERRIDE == null && batch.review_depth && batch.review_depth !== minDepth) {
      log(`server asks for depth ${batch.review_depth} (was using ${minDepth})`)
      minDepth = batch.review_depth
      continue
    }
  } catch (error) {
    // Probed rather than assumed: "fetch failed" alone sent nobody to the
    // backend for thirty-five hours.
    const report = outage.fail(error.message, { backend: await probeBackend() })
    log(report.message)
    await sleep(Math.max(report.delayMs, error.retryAfterMs ?? 0))
    continue
  }
  const recovered = outage.recover()
  if (recovered) log(recovered.message)

  if (batch.fens.length === 0) {
    // Say what is being held back: "nothing queued" while positions are set
    // aside is not the same as a finished library, and reading it as one is
    // how thirty idle hours went unnoticed.
    const held = unfinished.size
    const heldBack = held === 0 ? '' : `; ${held} set aside after timeouts, next back in ${formatDuration(unfinished.nextRetryMs())}`
    const waitMs = idleWait.next(`${batch.analyzed_count}/${batch.candidate_count}/${held}`)
    log(`nothing queued; ${batch.analyzed_count}/${batch.candidate_count} positions covered${heldBack}; next look in ${formatDuration(waitMs)}`)
    await sleep(waitMs)
    continue
  }
  idleWait.reset()

  // One shared queue, every engine taking the next position as it frees up, so
  // a single slow search cannot hold up the others. Nothing here needs a lock:
  // the loop is asynchronous but the runtime is single-threaded, so shift() and
  // push() never interleave mid-operation.
  const queue = [...batch.fens]
  const items = []
  const engines = await poolOf(active)
  // Record the size actually running, so the next resize discounts our own
  // contribution to the load average rather than reading it as other work.
  loadHistory.record(active)

  // Waiting for the batch to end before reacting to pressure means 30-60s of
  // full pool at exactly the moment someone starts using the machine. Poll
  // during the batch instead: engines past the cut finish the position in hand
  // and then stop taking new ones, so relief arrives in seconds without
  // abandoning a search (an abandoned search does not stop the engine).
  let liveLimit = active
  const pressureTimer = setInterval(() => {
    const now = cpuPressure()
    const cut = pressureLimit({ active: liveLimit, pressure: now, maxPressure: MAX_PRESSURE, min: WORKERS_MIN })
    if (cut < liveLimit) {
      log(`cpu pressure ${now.toFixed(1)}% over ${MAX_PRESSURE}%, releasing ${liveLimit - cut} engine(s) mid-batch`)
      liveLimit = cut
    }
  }, PRESSURE_POLL_MS)
  pressureTimer.unref?.()

  // Presence is checked on its own, faster clock and drops straight to the cap
  // rather than halving: the point is that the person never feels a ramp-down,
  // so there is nothing to ease into.
  const presenceCutTimer = setInterval(() => {
    const ceiling = presenceLimit()
    if (ceiling < liveLimit) {
      log(`machine in use (${(lastOtherCores ?? 0).toFixed(2)} cores), ` +
          `releasing ${liveLimit - ceiling} engine(s) mid-batch`)
      liveLimit = ceiling
    }
  }, PRESENCE_POLL_MS)
  presenceCutTimer.unref?.()

  // Heat is the one cut that cannot wait for the batch either, and for a
  // different reason than presence: a batch is 30-60s, and that is long enough
  // to take the package from its baseline to the throttling band and hold it
  // there. Waiting would mean the guard never prevents a throttle, only records
  // one. Like presence it drops straight to the ceiling -- which, when hot, is
  // zero, because heat is shed by stopping rather than by running smaller.
  const thermalCutTimer = setInterval(() => {
    // The global sampler owns the clock; sampling here doubles the rate during work.
    // Judged against what is running, so the warm band holds this batch where
    // it is instead of reading as a cut down to the minimum. Only `hot` cuts
    // mid-batch, and it cuts to zero.
    const ceiling = thermalLimit(liveLimit)
    if (ceiling < liveLimit) {
      log(`package ${(lastTempC ?? 0).toFixed(0)}C, ` +
          `releasing ${liveLimit - ceiling} engine(s) mid-batch`)
      liveLimit = ceiling
    }
  }, THERMAL_POLL_MS)
  thermalCutTimer.unref?.()

  await Promise.all(engines.map(async ({ analyse }, index) => {
    for (;;) {
      if (stopping) return
      // This engine is past the current cut: stand it down for the rest of the
      // batch rather than starting another position.
      if (index >= liveLimit) return
      const fen = queue.shift()
      if (fen === undefined) return
      // The server asks for the depth this position's partner already carries,
      // so the pair can be differenced at a depth they share.
      const depth = batch.fen_depths?.[fen] ?? minDepth
      const searchFen = fen.trim().split(/\s+/).length === 6 ? fen : `${fen} 0 1`
      try {
        const result = await analyse(searchFen, depth)
        unfinished.resolved(fen)
        // A checkmated or stalemated position has no move to store; the server
        // records those as exact outcomes instead.
        if (!result.terminal && result.bestMoveUci) {
          items.push({
            fen, depth: result.depth,
            eval_cp: result.evalCp, eval_mate: result.evalMate,
            best_move_uci: result.bestMoveUci, pv_uci: result.pvUci ?? undefined,
            multipv_rank: 1, engine: 'stockfish-19', engine_version: '19',
          })
        }
      } catch (error) {
        // A worker that never acknowledged stop cannot safely search again.
        // Exit so the supervised container replaces the whole poisoned pool.
        if (error.fatal) throw error
        // Remember it, so the queue stops handing back a search we cannot
        // finish. A depth that deep was asked for by someone studying the
        // position in the browser, which is where it can still be filled.
        const { delayMs } = unfinished.add(fen)
        log(`skipped a position (${unfinished.size} set aside, this one for ${formatDuration(delayMs)}): ${error.message}`)
      }
      await sleep(REST_MS)
    }
  }))
  clearInterval(pressureTimer)
  clearInterval(presenceCutTimer)
  clearInterval(thermalCutTimer)
  // Carry a mid-batch cut into the next round, so relief is not undone the
  // instant the batch ends. Growing back is the controller's job, on its clock.
  if (liveLimit < active) {
    log(`pool ${active} -> ${liveLimit} engine(s) after mid-batch pressure relief`)
    active = liveLimit
    quietStreak = 0
  }

  // A failed upload is the backend being restarted or briefly unreachable, not
  // the crawl running out of work. Counting it as idle used to end the run for
  // good after five tries — with exit code 0, so `restart: on-failure` would
  // not bring it back either. Keep retrying, with a backoff, so a deploy in the
  // middle of a multi-day crawl costs a few minutes instead of the rest of it.
  const stored = await uploadWithRetry(items, {
    upload, stopping: () => stopping, sleep, busyMs: BUSY_MS,
    maxRetryMs: UPLOAD_RETRY_MAX_MS, log,
  })
  if (stored === null) break

  totalStored += stored.stored
  const percent = (100 * batch.analyzed_count / Math.max(batch.candidate_count, 1)).toFixed(2)
  log(`batch: searched ${items.length}, stored ${stored.stored}, skipped ${stored.skipped} ` +
      `| coverage ${percent}% | session total ${totalStored}`)
  idleBatches = stored.stored === 0 ? idleBatches + 1 : 0

  if (idleBatches >= MAX_IDLE_BATCHES) {
    // The server keeps handing out work the engine cannot turn into new rows.
    // Worth saying loudly, but not worth ending a multi-day crawl over: wait it
    // out and look again, rather than exiting and needing someone to notice.
    log(`${idleBatches} batches stored nothing; pausing ${Math.round(IDLE_STALL_MS / 60000)}min before looking again`)
    await sleep(IDLE_STALL_MS)
    idleBatches = 0
  }
}

log(`stopped after storing ${totalStored} evaluations`)
process.exit(0)
