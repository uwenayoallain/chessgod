import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { requestJson } from './http.mjs'
import { uploadEvaluations } from './upload.mjs'

async function withServer(handler, check) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await check(`http://127.0.0.1:${server.address().port}`)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

test('successful JSON responses are preserved', async () => {
  await withServer((req, res) => res.end('{"stored":24}'), async url => {
    assert.deepEqual(await requestJson(url), { stored: 24 })
  })
})

test('structured HTTP validation errors preserve the valid evaluations', async () => {
  const batches = []
  await withServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    batches.push(JSON.parse(body).items)
    res.setHeader('content-type', 'application/json')
    if (batches.length === 1) {
      res.writeHead(422)
      res.end(JSON.stringify({ detail: [{ loc: ['body', 'items', 1, 'pv_uci'] }] }))
    } else {
      res.end(JSON.stringify({ stored: 1 }))
    }
  }, async url => {
    const result = await uploadEvaluations(url, [{ fen: 'valid' }, { fen: 'invalid' }])
    assert.deepEqual(batches[1], [{ fen: 'valid' }])
    assert.deepEqual(result, { stored: 1, skipped: 0, upgraded: 0, rejected: 1 })
  })
})

for (const status of [400, 413, 422, 401, 408, 429, 503]) {
  test(`HTTP ${status} has the appropriate retry policy`, async () => {
    await withServer((req, res) => {
      res.writeHead(status, { 'retry-after': '17' })
      res.end('rejected')
    }, async url => {
      await assert.rejects(requestJson(url), error => {
        assert.equal(error.permanent, [400, 413, 422].includes(status))
        assert.equal(error.retryAfterMs, 17_000)
        return true
      })
    })
  })
}

for (const sendHeaders of [false, true]) {
  test(`deadline covers a stalled ${sendHeaders ? 'body' : 'connection'}`, async () => {
    await withServer((req, res) => {
      if (sendHeaders) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{')
      }
    }, async url => {
      await assert.rejects(requestJson(url, { timeoutMs: 50 }), error => {
        assert.notEqual(error.permanent, true)
        return true
      })
    })
  })
}
