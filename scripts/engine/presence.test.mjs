import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseProcStat, parseCgroupUsage, otherCoresBetween, presenceCeiling,
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
