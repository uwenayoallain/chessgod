import assert from 'node:assert/strict'
import { test } from 'node:test'
import { engineTimeouts } from './timeouts.mjs'
import { createEngine } from './sf19.mjs'

test('default deadlines retain the search and stop grace budget', () => {
  assert.deepEqual(engineTimeouts({}), { search: 180_000, grace: 15_000 })
  assert.deepEqual(engineTimeouts({ ENGINE_SEARCH_TIMEOUT_MS: '700', ENGINE_STOP_GRACE_MS: '20' }),
    { search: 700, grace: 20 })
})

for (const key of ['ENGINE_SEARCH_TIMEOUT_MS', 'ENGINE_STOP_GRACE_MS']) {
  for (const value of ['', ' ', 'NaN', 'Infinity', '-1', '0', '0.5', '2147483648']) {
    test(`${key} rejects ${JSON.stringify(value)} instead of creating a 1ms timer`, () => {
      assert.throws(() => engineTimeouts({ [key]: value }), new RegExp(key))
    })
  }
}

test('individually valid delays cannot overflow the combined hard deadline', () => {
  assert.throws(() => engineTimeouts({ ENGINE_SEARCH_TIMEOUT_MS: '2147483647' }), /Combined/)
  assert.deepEqual(engineTimeouts({ ENGINE_SEARCH_TIMEOUT_MS: '2147483646', ENGINE_STOP_GRACE_MS: '1' }),
    { search: 2147483646, grace: 1 })
})

test('engine creation rejects invalid configuration before booting WASM', async () => {
  const previous = process.env.ENGINE_SEARCH_TIMEOUT_MS
  process.env.ENGINE_SEARCH_TIMEOUT_MS = 'not-a-number'
  try {
    await assert.rejects(createEngine(), /ENGINE_SEARCH_TIMEOUT_MS/)
  } finally {
    if (previous === undefined) delete process.env.ENGINE_SEARCH_TIMEOUT_MS
    else process.env.ENGINE_SEARCH_TIMEOUT_MS = previous
  }
})
