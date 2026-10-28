import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSetAside } from './setaside.mjs'

const HOUR = 3_600_000

test('a timed-out position is excluded, then offered again', () => {
  let now = 0
  const setAside = createSetAside({ baseMs: HOUR, clock: () => now })
  setAside.add('a')
  assert.deepEqual(setAside.excluded(), ['a'])
  assert.equal(setAside.size, 1)
  now = HOUR
  // The incident: a set that never emptied starved the crawl for thirty hours.
  assert.deepEqual(setAside.excluded(), [])
  assert.equal(setAside.size, 0)
})

test('each failure doubles the wait, up to a ceiling', () => {
  const setAside = createSetAside({ baseMs: HOUR, maxMs: 8 * HOUR, clock: () => 0 })
  const delays = Array.from({ length: 6 }, () => setAside.add('a').delayMs / HOUR)
  assert.deepEqual(delays, [1, 2, 4, 8, 8, 8])
})

test('a position that finishes is forgotten, so a later timeout starts over', () => {
  const setAside = createSetAside({ baseMs: HOUR, clock: () => 0 })
  setAside.add('a')
  setAside.add('a')
  setAside.resolved('a')
  assert.equal(setAside.size, 0)
  assert.equal(setAside.add('a').delayMs, HOUR)
})

test('the newest failure is last, so a capped exclusion list keeps it', () => {
  const setAside = createSetAside({ baseMs: HOUR, clock: () => 0 })
  setAside.add('a')
  setAside.add('b')
  setAside.add('a')
  assert.deepEqual(setAside.excluded(), ['b', 'a'])
  assert.deepEqual(setAside.excluded().slice(-1), ['a'])
})

test('says how long until the next position comes back', () => {
  let now = 0
  const setAside = createSetAside({ baseMs: HOUR, clock: () => now })
  assert.equal(setAside.nextRetryMs(), null)
  setAside.add('a')
  now = 10 * 60_000
  setAside.add('b')
  assert.equal(setAside.nextRetryMs(), 50 * 60_000)
})
