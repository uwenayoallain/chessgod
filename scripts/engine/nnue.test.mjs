import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyNnueBytes } from './nnue.mjs'

test('verified NNUE bytes are returned without allocating another copy', () => {
  const bytes = Buffer.from([1, 2, 3])
  assert.equal(verifyNnueBytes('nn-039058c6f2c0.nnue', bytes), bytes)
})

test('a corrupt or empty NNUE is rejected', () => {
  for (const bytes of [Buffer.from([1, 2, 4]), Buffer.alloc(0)]) {
    assert.throws(() => verifyNnueBytes('nn-039058c6f2c0.nnue', bytes), /integrity/)
  }
})

test('network names cannot escape the asset directory or omit the hash', () => {
  for (const filename of ['../nn-039058c6f2c0.nnue', '/nn-039058c6f2c0.nnue', 'network.nnue']) {
    assert.throws(() => verifyNnueBytes(filename, Buffer.from([1, 2, 3])), /filename/)
  }
})
