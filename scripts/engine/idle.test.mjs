import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createIdleWait } from './idle.mjs'

test('an unchanged empty queue is asked less and less often, up to a ceiling', () => {
  const idle = createIdleWait({ baseMs: 60_000, maxMs: 1_800_000 })
  const waits = Array.from({ length: 7 }, () => idle.next('99/100'))
  assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000])
})

test('new games or new coverage start the wait over', () => {
  const idle = createIdleWait({ baseMs: 60_000, maxMs: 1_800_000 })
  idle.next('99/100')
  idle.next('99/100')
  assert.equal(idle.next('99/120'), 60_000)
  idle.next('99/120')
  idle.reset()
  assert.equal(idle.next('99/120'), 60_000)
})
