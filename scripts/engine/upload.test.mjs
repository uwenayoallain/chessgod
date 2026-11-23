import assert from 'node:assert/strict'
import { test } from 'node:test'
import { uploadEvaluations } from './upload.mjs'

const invalid = (...indices) => Object.assign(new Error('validation failed'), {
  status: 422, permanent: true,
  detail: indices.map(index => ({ loc: ['body', 'items', index, 'pv_uci'] })),
})

test('a rejected item does not discard the other completed evaluations', async () => {
  const items = [{ fen: 'one' }, { fen: 'bad' }, { fen: 'three' }]
  const calls = [], rejected = []
  const result = await uploadEvaluations('http://localhost', items, {
    request: async (url, options) => {
      calls.push(JSON.parse(options.body).items)
      if (calls.length === 1) throw invalid(1, 1)
      return { stored: 2, skipped: 0, upgraded: 1 }
    },
    onRejected: rows => rejected.push(...rows),
  })
  assert.deepEqual(calls[1], [items[0], items[2]])
  assert.deepEqual(rejected, [items[1]])
  assert.equal(items.length, 3)
  assert.deepEqual(result, { stored: 2, skipped: 0, upgraded: 1, rejected: 1 })
})

test('an entirely rejected chunk terminates without an empty upload', async () => {
  let calls = 0
  const result = await uploadEvaluations('http://localhost', [{}, {}], {
    request: async () => { calls++; throw invalid(0, 1) },
  })
  assert.equal(calls, 1)
  assert.equal(result.rejected, 2)
  assert.equal(result.stored, 0)
})

test('large batches respect the API limit and retain all successful counts', async () => {
  const sizes = []
  const result = await uploadEvaluations('http://localhost', Array.from({ length: 205 }, () => ({})), {
    request: async (url, options) => {
      const size = JSON.parse(options.body).items.length
      sizes.push(size)
      return { stored: size }
    },
  })
  assert.deepEqual(sizes, [100, 100, 5])
  assert.equal(result.stored, 205)
})

for (const error of [invalid(-1), invalid(4), invalid('0'), invalid(),
  Object.assign(invalid(0), { status: 503 }),
  Object.assign(invalid(0), { detail: [{ loc: ['body', 'items'] }] }),
  new Error('network offline')]) {
  test(`ambiguous errors are propagated: ${JSON.stringify(error)}`, async () => {
    let calls = 0
    await assert.rejects(uploadEvaluations('http://localhost', [{}], {
      request: async () => { calls++; throw error },
    }), caught => caught === error)
    assert.equal(calls, 1)
  })
}

test('rejection details survive retries with indices relative to the current batch', async () => {
  const items = [{ fen: 'bad-board' }, { fen: 'bad-pv' }, { fen: 'valid' }]
  const reports = []
  let calls = 0
  await uploadEvaluations('http://localhost', items, {
    request: async () => {
      calls++
      if (calls <= 2) {
        const error = invalid(0)
        error.detail[0].msg = calls === 1 ? 'Invalid chess position' : 'Illegal PV move'
        throw error
      }
      return { stored: 1 }
    },
    onRejected: (rows, details) => reports.push({ rows, details }),
  })
  assert.equal(calls, 3)
  assert.equal(reports[0].rows[0].fen, 'bad-board')
  assert.equal(reports[0].details[0].msg, 'Invalid chess position')
  assert.equal(reports[1].rows[0].fen, 'bad-pv')
  assert.equal(reports[1].details[0].msg, 'Illegal PV move')
})
