/**
 * A search that times out must not poison the next one.
 *
 * Rejecting on a timer does not stop the engine. The abandoned search keeps
 * going, and its `bestmove` arrives while the *next* position is being
 * searched — so that position is stored with another position's evaluation.
 * Nothing looks wrong: the numbers are real, just attached to the wrong board.
 * In the wild one timeout at depth 34 poisoned every later search on that
 * engine, and only the server's own validator noticed, by which point the crawl
 * had been rejecting every batch for seven hours.
 *
 * Drives the real engine, so it is slower than the pure tests. Run with
 * `node --test`.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'

// A short fuse, so a deep search is guaranteed to be abandoned mid-flight.
process.env.ENGINE_SEARCH_TIMEOUT_MS = '700'
const { createEngine } = await import('./sf19.mjs')

// Black is in check from the queen on g7, which is undefended, and every other
// king square is covered: capturing is the only legal move in the position.
const ONLY_MOVE_FEN = '7k/6Q1/8/8/8/8/8/7K b - - 0 1'
const ONLY_MOVE = 'h8g7'
const SLOW_FEN = 'r1b2rk1/pp1nqppp/2p1pn2/3p4/2PP4/2NBPN2/PPQ2PPP/R3K2R w KQ - 0 1'

const engine = await createEngine({ threads: 1, hash: 32 })
// Let the test runner report the final assertion before releasing WASM threads;
// an immediate forced success exit hid the last test's result.
after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 50) })

test('a search that runs past its deadline is rejected, not returned', async () => {
  await assert.rejects(
    () => engine.analyse(SLOW_FEN, 60),
    /timeout at depth 60|engine did not stop/,
  )
})

test('the next search after a timeout answers its own position', async () => {
  // Before the fix this returned the abandoned search's move — a legal move in
  // a different position, and nonsense in this one.
  const result = await engine.analyse(ONLY_MOVE_FEN, 8)

  assert.equal(result.bestMoveUci, ONLY_MOVE)
  assert.equal(result.pvUci.split(' ')[0], ONLY_MOVE)
})

test('the engine keeps working for searches after that', async () => {
  const result = await engine.analyse(ONLY_MOVE_FEN, 10)

  assert.equal(result.bestMoveUci, ONLY_MOVE)
})
