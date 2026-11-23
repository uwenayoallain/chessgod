import test from 'node:test'
import assert from 'node:assert/strict'
import {
  targetWorkers, createLoadHistory, nextWorkers, parseCpuPressure, pressureLimit,
} from './pool.mjs'

const base = { cores: 8, threads: 1, maxLoad: 0.7, min: 1, max: 6 }

test('an idle machine is filled up to the load budget', () => {
  // 8 cores * 0.7 = 5.6 cores of budget, so five engines -- the ceiling of six
  // is not the binding constraint here, the budget is.
  assert.equal(targetWorkers({ ...base, loadavg1: 0.2, ourRecentWorkers: 0 }), 5)
})

test('our own engines are not mistaken for other work', () => {
  // Five of our engines running on an otherwise idle box: the load is ours, so
  // the pool must hold rather than reading itself as a busy machine and
  // throttling down. Without the subtraction this would return 0.
  assert.equal(targetWorkers({ ...base, loadavg1: 5.1, ourRecentWorkers: 5 }), 5)
  assert.equal(targetWorkers({ ...base, loadavg1: 5.1, ourRecentWorkers: 0 }), 0)
})

test('other work shrinks the pool instead of stopping it', () => {
  // Someone is compiling on three cores: 8*0.7 - 3 = 2.6 cores left for us.
  assert.equal(targetWorkers({ ...base, loadavg1: 3, ourRecentWorkers: 0 }), 2)
})

test('the pool stands down only when not even one engine fits', () => {
  // Budget is 5.6 cores, so one engine still fits until other work passes 4.6.
  assert.equal(targetWorkers({ ...base, loadavg1: 4.6, ourRecentWorkers: 0 }), 1)
  assert.equal(targetWorkers({ ...base, loadavg1: 4.7, ourRecentWorkers: 0 }), 0)
})

test('the floor is respected while at least one engine still fits', () => {
  // 8*0.7 - 4 = 1.6 cores left, which rounds down to one engine; a floor of
  // two keeps a little forward progress rather than crawling at one.
  assert.equal(targetWorkers({ ...base, min: 2, loadavg1: 4, ourRecentWorkers: 0 }), 2)
  // But a floor never overrides standing down: below one engine of budget the
  // crawler yields the machine outright.
  assert.equal(targetWorkers({ ...base, min: 2, loadavg1: 5.7, ourRecentWorkers: 0 }), 0)
})

test('a wider engine counts for more than one core', () => {
  // 8*0.7 = 5.6 cores of budget, two threads each: only two engines fit.
  assert.equal(targetWorkers({ ...base, threads: 2, loadavg1: 0, ourRecentWorkers: 0 }), 2)
})

test('the ceiling is never exceeded on a completely idle machine', () => {
  assert.equal(targetWorkers({ ...base, max: 3, loadavg1: 0, ourRecentWorkers: 0 }), 3)
})

test('recent pool size survives a shrink so our own load is still discounted', () => {
  let clock = 1_000_000
  const history = createLoadHistory({ windowMs: 60_000, now: () => clock })
  history.record(6)
  clock += 5_000
  // We just shrank to 1, but loadavg still carries the six we were running.
  assert.equal(history.recentMax(1), 6)
  // Without this the pool would ratchet down: load 6 minus 1 reads as five
  // cores of other work and would stand the crawler down entirely.
  assert.equal(targetWorkers({ ...base, loadavg1: 6, ourRecentWorkers: 6 }), 5)
  assert.equal(targetWorkers({ ...base, loadavg1: 6, ourRecentWorkers: 1 }), 0)
})

test('pool sizes older than the load average window are forgotten', () => {
  let clock = 1_000_000
  const history = createLoadHistory({ windowMs: 60_000, now: () => clock })
  history.record(6)
  clock += 61_000
  assert.equal(history.recentMax(1), 1)
})

test('a busy machine shrinks the pool immediately', () => {
  // Yielding is never delayed: the whole point of the patience is to slow
  // growth, not to hold cores while someone is waiting for them.
  assert.equal(nextWorkers({ active: 5, target: 1, quietStreak: 0 }), 1)
  assert.equal(nextWorkers({ active: 5, target: 0, quietStreak: 9 }), 0)
})

test('growth is one engine at a time, never a leap back to the ceiling', () => {
  // The sawtooth this prevents: standing down, then immediately re-inviting
  // every engine because the load they caused has just decayed.
  assert.equal(nextWorkers({ active: 0, target: 5, quietStreak: 2 }), 1)
  assert.equal(nextWorkers({ active: 1, target: 5, quietStreak: 2 }), 2)
})

test('the first engine comes back without waiting for patience', () => {
  // A stopped pool adds no load, so there is nothing to measure the cost of;
  // making it wait only leaves the crawler idle every time it resumes.
  assert.equal(nextWorkers({ active: 0, target: 4, quietStreak: 0 }), 1)
})

test('growth waits for the headroom to hold', () => {
  assert.equal(nextWorkers({ active: 2, target: 5, quietStreak: 0 }), 2)
  assert.equal(nextWorkers({ active: 2, target: 5, quietStreak: 1 }), 2)
  assert.equal(nextWorkers({ active: 2, target: 5, quietStreak: 2 }), 3)
})

test('growth is paced by time, not by how quickly batches happen to finish', () => {
  // A batch is only as long as the pool running it. At one engine it is a
  // handful of positions and can finish in seconds, which let the pool go
  // 1->2->3->4->5 in fifty-one seconds with three seconds between the first two
  // steps -- no load-average window anywhere in it, which is the entire reason
  // the wait exists.
  const ready = { active: 2, target: 5, quietStreak: 99, growIntervalMs: 45_000 }
  assert.equal(nextWorkers({ ...ready, msSinceGrowth: 3_000 }), 2)
  assert.equal(nextWorkers({ ...ready, msSinceGrowth: 44_999 }), 2)
  assert.equal(nextWorkers({ ...ready, msSinceGrowth: 45_000 }), 3)
})

test('the growth clock never delays getting out of the way', () => {
  // Shrinking ignores both the streak and the clock.
  assert.equal(nextWorkers({ active: 5, target: 1, quietStreak: 99, msSinceGrowth: 0 }), 1)
})

test('the first engine still returns immediately, clock or not', () => {
  assert.equal(nextWorkers({ active: 0, target: 5, quietStreak: 0, msSinceGrowth: 0 }), 1)
})

test('a pool already at its target does not drift', () => {
  assert.equal(nextWorkers({ active: 3, target: 3, quietStreak: 5 }), 3)
})

test('an idle machine still reaches the ceiling, just not in one step', () => {
  let active = 0
  for (let batch = 0; batch < 20 && active < 5; batch += 1) {
    active = nextWorkers({ active, target: 5, quietStreak: 99 })
  }
  assert.equal(active, 5)
})

test('cpu pressure is read from the some/avg10 field', () => {
  const sample = 'some avg10=12.34 avg60=0.97 avg300=2.02 total=13567448484\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'
  assert.equal(parseCpuPressure(sample), 12.34)
})

test('a machine without PSI reports no pressure rather than zero', () => {
  // null and 0 must not be confused: 0 would read as "measured, and idle",
  // which would let a pressure rule fire on a machine that cannot measure it.
  assert.equal(parseCpuPressure(''), null)
  assert.equal(parseCpuPressure('full avg10=1.0'), null)
  assert.equal(parseCpuPressure(undefined), null)
})

test('pressure below the threshold leaves the pool alone', () => {
  assert.equal(pressureLimit({ active: 5, pressure: 1.69, maxPressure: 20 }), 5)
})

test('real stalling halves the pool at once rather than one engine per batch', () => {
  assert.equal(pressureLimit({ active: 5, pressure: 45, maxPressure: 20 }), 2)
  assert.equal(pressureLimit({ active: 2, pressure: 45, maxPressure: 20 }), 1)
})

test('pressure never grows the pool and never starves it below the floor', () => {
  assert.equal(pressureLimit({ active: 1, pressure: 99, maxPressure: 20 }), 1)
  assert.equal(pressureLimit({ active: 3, pressure: 0, maxPressure: 20 }), 3)
})

test('an unmeasurable machine falls back to the load budget alone', () => {
  assert.equal(pressureLimit({ active: 5, pressure: null, maxPressure: 20 }), 5)
})
