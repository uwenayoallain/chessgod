import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const crawler = fileURLToPath(new URL('./crawl.mjs', import.meta.url))

// crawl.mjs evaluates every module-level constant and only then checks for
// CRAWL_USERNAME, exiting 2 before an engine is ever created. That makes the
// whole initialisation path testable in about a tenth of a second.
//
// It is worth testing because `node --check` does not catch it and no other
// test imports this file (importing it starts engines): a const that read
// WORKERS_MAX from above its declaration threw
// `ReferenceError: Cannot access 'WORKERS_MAX' before initialization`
// only once the container was already crash-looping.
test('the crawler initialises without a temporal-dead-zone error', async () => {
  const env = { ...process.env }
  delete env.CRAWL_USERNAME

  const failure = await run('node', [crawler], { env }).then(
    () => null,
    error => error,
  )

  assert.ok(failure, 'expected the crawler to refuse to run without a username')
  assert.equal(failure.code, 2, `expected exit 2, got ${failure.code}: ${failure.stderr}`)
  assert.match(failure.stderr, /CRAWL_USERNAME is required/)
  assert.doesNotMatch(failure.stderr, /ReferenceError/)
})
