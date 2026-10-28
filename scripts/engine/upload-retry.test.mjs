import test from 'node:test'
import assert from 'node:assert/strict'
import { uploadWithRetry } from './upload.mjs'

test('shutdown flushes completed evaluations once', async () => {
  const items = [{ fen: 'completed search' }]
  let calls = 0
  const result = await uploadWithRetry(items, {
    stopping: () => true,
    upload: async received => { calls++; assert.equal(received, items); return { stored: 1 } },
    sleep: async () => assert.fail('shutdown must not sleep'),
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, { stored: 1 })
})

test('an unavailable backend does not trap shutdown in retries', async () => {
  let calls = 0
  const result = await uploadWithRetry([{}], {
    stopping: () => true,
    upload: async () => { calls++; throw new Error('offline') },
    sleep: async () => assert.fail('shutdown must not sleep'),
  })
  assert.equal(calls, 1)
  assert.equal(result, null)
})

test('running crawler retries with bounded backoff and honors server delay', async () => {
  let calls = 0
  const waits = []
  const result = await uploadWithRetry([{}], {
    stopping: () => false, busyMs: 100, maxRetryMs: 150,
    upload: async () => {
      calls++
      if (calls < 4) throw Object.assign(new Error('offline'), { retryAfterMs: calls === 3 ? 500 : 0 })
      return { stored: 1 }
    },
    sleep: async ms => { waits.push(ms) },
  })
  assert.deepEqual(waits, [100, 150, 500])
  assert.deepEqual(result, { stored: 1 })
})
