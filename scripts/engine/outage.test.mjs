import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOutage, formatDuration } from './outage.mjs'

test('durations read as a person would say them', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(35_000), '35s')
  assert.equal(formatDuration(250_000), '4m 10s')
  assert.equal(formatDuration(300_000), '5m')
  assert.equal(formatDuration(126_720_000), '35h 12m')
})

test('retries back off to a ceiling instead of hammering every poll', () => {
  const outage = createOutage({ baseMs: 30_000, maxMs: 300_000, clock: () => 0 })
  const delays = Array.from({ length: 6 }, () => outage.fail('fetch failed').delayMs)
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000, 300_000, 300_000])
})

test('a 35-hour outage costs hundreds of requests, not thousands', () => {
  // The incident this module exists for: 35h of retries every 35s.
  let now = 0
  const outage = createOutage({ baseMs: 30_000, maxMs: 300_000, clock: () => now })
  let attempts = 0
  while (now < 35 * 60 * 60 * 1000) {
    now += outage.fail('fetch failed').delayMs
    attempts += 1
  }
  assert.ok(attempts < 450, `expected far fewer than the old 3,600 attempts, got ${attempts}`)
})

test('every line after the first says how long the queue has been gone', () => {
  let now = 0
  const outage = createOutage({ clock: () => now })
  assert.match(outage.fail('fetch failed').message, /^queue unavailable \(fetch failed\)/)
  now = 126_720_000
  assert.match(outage.fail('fetch failed').message, /queue unavailable for 35h 12m/)
})

test('the line names the backend, because that is what a reader has to fix', () => {
  const outage = createOutage({ clock: () => 0 })
  assert.match(outage.fail('fetch failed', { backend: 'down' }).message, /backend is not answering/)
  assert.match(outage.fail('HTTP 500', { backend: 'up' }).message, /backend is healthy, so the queue endpoint itself is failing/)
})

test('a probe that could not run is not reported as a down backend', () => {
  const outage = createOutage({ clock: () => 0 })
  const unknown = outage.fail('fetch failed', { backend: 'unknown' }).message
  assert.match(unknown, /could not be probed/)
  assert.doesNotMatch(unknown, /not answering/)
  assert.match(outage.fail('fetch failed').message, /backend health could not be probed/)
})

test('recovery is logged once, and a crawl that never failed says nothing', () => {
  let now = 0
  const outage = createOutage({ clock: () => now })
  assert.equal(outage.recover(), null)
  outage.fail('fetch failed')
  outage.fail('fetch failed')
  now = 3_600_000
  const recovered = outage.recover()
  assert.match(recovered.message, /queue reachable again after 1h unavailable \(2 attempts\)/)
  assert.equal(outage.recover(), null)
  assert.equal(outage.failing, false)
})

test('a second outage starts its own clock rather than continuing the first', () => {
  let now = 0
  const outage = createOutage({ baseMs: 30_000, clock: () => now })
  outage.fail('fetch failed')
  now = 600_000
  outage.recover()
  const next = outage.fail('fetch failed')
  assert.equal(next.attempts, 1)
  assert.equal(next.downMs, 0)
  assert.equal(next.delayMs, 30_000)
})
