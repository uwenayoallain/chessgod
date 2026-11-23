import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseProcStat, parseCgroupUsage, otherCoresBetween, presenceCeiling, createOwnWork,
  createActivityWindow,
} from './presence.mjs'

const STAT = 'cpu  21999783 8818270 3118145 43856113 87658 0 116732 0 0 0\ncpu0 1 2 3\n'

test('proc stat separates busy time from idle', () => {
  const parsed = parseProcStat(STAT)
  // user+nice+system+irq+softirq+steal, in USER_HZ ticks, over 100.
  assert.equal(parsed.busy, (21999783 + 8818270 + 3118145 + 0 + 116732 + 0) / 100)
  // iowait counts as available, not busy: a core waiting on disk is free.
  assert.equal(parsed.total, parsed.busy + (43856113 + 87658) / 100)
})

test('a malformed or missing proc stat reports nothing rather than zero', () => {
  assert.equal(parseProcStat('garbage'), null)
  assert.equal(parseProcStat(''), null)
  assert.equal(parseCgroupUsage('nr_periods 5'), null)
})

test('cgroup usage is read in seconds', () => {
  assert.equal(parseCgroupUsage('usage_usec 2365630451\nuser_usec 1'), 2365.630451)
})

test('corrupt CPU counters cannot masquerade as an idle host', () => {
  for (const value of ['cpu 1 bad 3 4 5 6 7 8', 'cpu 1 2', 'cpu -1 2 3 4 5 6 7 8']) {
    assert.equal(parseProcStat(value), null)
  }
  for (const value of ['usage_usec 123oops', 'usage_usec 1.5', 'usage_usec 999999999999999999999']) {
    assert.equal(parseCgroupUsage(value), null)
  }
})

test('counter resets and invalid samples do not report idleness', () => {
  const before = { busy: 100, ours: 50, at: 0 }
  for (const after of [
    { busy: 1, ours: 1, at: 2000 },
    { busy: 106, ours: 1, at: 2000 },
    { busy: NaN, ours: 51, at: 2000 },
    { busy: 106, ours: 51, at: Infinity },
  ]) assert.equal(otherCoresBetween(before, after), null)
})

test('other-cores subtracts our own usage from the machine total', () => {
  // Over 2s the machine was busy 6 core-seconds and we used 4 of them, so
  // everyone else used 2 core-seconds => 1.0 core.
  const before = { busy: 100, ours: 50, at: 0 }
  const after = { busy: 106, ours: 54, at: 2000 }
  assert.equal(otherCoresBetween(before, after), 1.0)
})

test('our own engines are never counted as somebody else working', () => {
  // The crawler alone: every busy second is ours, so nobody else is present.
  const before = { busy: 100, ours: 50, at: 0 }
  const after = { busy: 106, ours: 56, at: 2000 }
  assert.equal(otherCoresBetween(before, after), 0)
})

test('a missing or non-advancing sample yields null, not idleness', () => {
  // Reading a gap as 0 would look like "nobody is here" and invite the pool to
  // grow at exactly the wrong moment.
  assert.equal(otherCoresBetween(null, { busy: 1, ours: 1, at: 1 }), null)
  assert.equal(otherCoresBetween({ busy: 1, ours: 1, at: 5 }, { busy: 2, ours: 1, at: 5 }), null)
})

const CEIL = { idleAfterMs: 600_000, activeMax: 1, fullMax: 5 }

test('someone at the keyboard caps the pool hard', () => {
  assert.equal(presenceCeiling({ ...CEIL, msSinceActive: 0 }), 1)
  assert.equal(presenceCeiling({ ...CEIL, msSinceActive: 599_999 }), 1)
})

test('the full pool unlocks only after a long quiet stretch', () => {
  assert.equal(presenceCeiling({ ...CEIL, msSinceActive: 600_000 }), 5)
  assert.equal(presenceCeiling({ ...CEIL, msSinceActive: 3_600_000 }), 5)
})

test('the active cap never exceeds the configured maximum', () => {
  assert.equal(presenceCeiling({ idleAfterMs: 1, activeMax: 5, fullMax: 2, msSinceActive: 0 }), 2)
})

test('a sample that overlaps our own request is not evidence of a person', async () => {
  let now = 0
  const ownWork = createOwnWork({ clock: () => now })
  assert.equal(ownWork.overlaps(0), false)
  let finish
  const request = ownWork.around(() => new Promise(resolve => { finish = resolve }))
  // In flight: whatever the backend and Postgres are doing is on our behalf.
  assert.equal(ownWork.overlaps(-2_000), true)
  now = 3_000
  finish('ok')
  assert.equal(await request, 'ok')
  // A sample window that began before the request ended still contains its work.
  assert.equal(ownWork.overlaps(2_000), true)
  // One that began afterwards does not.
  assert.equal(ownWork.overlaps(3_001), false)
})

test('a failed request still ends, so presence is not blinded for good', async () => {
  let now = 0
  const ownWork = createOwnWork({ clock: () => now })
  now = 1_000
  await assert.rejects(ownWork.around(async () => { throw new Error('fetch failed') }))
  assert.equal(ownWork.overlaps(1_001), false)
})

// Host-only cores, 2s apart, recorded on this machine while a coding agent ran
// an `fplai update` job (~0.9 cores) next to qBittorrent, another project's
// Docker dev stack and two terminals. That is somebody using the machine, and
// the rule must say so.
const AGENT_AT_WORK = [
  0.73, 0.57, 0.38, 0.35, 0.45, 0.57, 1.14, 0.53, 0.52, 0.69, 0.61, 0.92, 0.43, 0.36, 1.58,
  0.42, 0.63, 0.58, 0.52, 1.39, 0.77, 1.46, 1.25, 0.54, 0.44, 0.62, 0.73, 0.56, 0.50, 0.68,
]

function trips(series, line = 1.0) {
  const activity = createActivityWindow({ size: 3 })
  return series.filter(cores => {
    activity.push(cores)
    return (activity.mean() ?? 0) >= line
  }).length
}

test('real work next to the background still reads as somebody here', () => {
  // With a ten-minute hold, a trip every twenty seconds or so keeps it in use.
  assert.ok(trips(AGENT_AT_WORK) >= 2)
})

test('the always-on background and its one-sample spikes do not', () => {
  // The floor measured per process: qBittorrent 0.25, GNOME Shell 0.09, the
  // other stack's JVMs 0.06 and the rest ~0.1 -- right on the old 0.5 line, so
  // under the old rule nothing ever went quiet. Spikes on it last one sample.
  const background = [0.5, 0.45, 1.5, 0.5, 0.55, 0.45, 1.2, 1.2, 0.5, 0.45, 0.6, 1.4, 0.5, 0.5, 0.45]
  assert.ok(background.filter(cores => cores >= 0.5).length >= 10, 'the old rule trips constantly')
  assert.equal(trips(background), 0)
})

test('somebody working trips it within one window', () => {
  // 1.36-1.94 cores is what the machine's owner working was measured at.
  const activity = createActivityWindow({ size: 3 })
  for (const cores of [0.45, 0.5, 1.4, 1.9, 1.6]) activity.push(cores)
  assert.ok(activity.mean() >= 1.0)
})

test('the window says nothing until it is full, and ignores gaps', () => {
  const activity = createActivityWindow({ size: 3 })
  activity.push(5)
  activity.push(null)
  activity.push(Number.NaN)
  assert.equal(activity.mean(), null)
})
