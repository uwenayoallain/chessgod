import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { requestJson } from './http.mjs'

test('a shutdown signal ends a request that is still waiting for its answer', async () => {
  // A queue request can take two minutes on a loaded machine; a crawler told
  // to stop must not sit out the whole of it.
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const shutdown = new AbortController()
  const started = Date.now()
  setTimeout(() => shutdown.abort(new Error('shutting down')), 50)
  try {
    await assert.rejects(
      requestJson(`http://127.0.0.1:${port}/`, { timeoutMs: 10_000, signal: shutdown.signal }),
    )
    assert.ok(Date.now() - started < 5_000)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
