import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createBatcher,
  DEFAULT_DEPTH,
  evaluationItems,
  MIN_TRUSTED_DEPTH,
  readConfig,
  searchAll,
  searchFen,
} from './repertoire.mjs'

const argv = (name) => ['node', 'repertoire.mjs', ...(name ? [name] : [])]

test('importing the script starts nothing and exits nothing', () => {
  // Reaching this line is the test: the old script called process.exit(2) on
  // import whenever USERNAME was unset.
  assert.equal(typeof readConfig, 'function')
})

test('defaults match the review depth and leave a core for the machine', () => {
  const config = readConfig({ USERNAME: 'player' }, argv(), 8)
  assert.equal(config.username, 'player')
  assert.deepEqual(config.colors, ['black'])
  assert.equal(config.depth, DEFAULT_DEPTH)
  assert.equal(config.engines, 2)
  assert.equal(config.api, 'http://localhost:18000')
})

test('one engine on a one-core machine, never none', () => {
  assert.equal(readConfig({ USERNAME: 'p', ENGINES: '4' }, argv(), 1).engines, 1)
  assert.equal(readConfig({ USERNAME: 'p', ENGINES: '4' }, argv(), 0).engines, 1)
  assert.equal(readConfig({ USERNAME: 'p', ENGINES: '4' }, argv(), 3).engines, 2)
  assert.equal(readConfig({ USERNAME: 'p', ENGINES: '1' }, argv(), 16).engines, 1)
})

test('a malformed number is refused rather than read as no engines at all', () => {
  // Number('two') is NaN, and Math.max(1, NaN) is NaN: the old clamp started
  // zero engines and reported every round as searched.
  assert.throws(() => readConfig({ USERNAME: 'p', ENGINES: 'two' }, argv(), 8), /ENGINES/)
  assert.throws(() => readConfig({ USERNAME: 'p', ENGINES: '0' }, argv(), 8), /ENGINES/)
  assert.throws(() => readConfig({ USERNAME: 'p', DEPTH: '20.5' }, argv(), 8), /DEPTH/)
})

test('a depth the repertoire builder would never read is refused', () => {
  assert.throws(
    () => readConfig({ USERNAME: 'p', DEPTH: String(MIN_TRUSTED_DEPTH - 1) }, argv(), 8),
    /at least 18/,
  )
  assert.equal(readConfig({ USERNAME: 'p', DEPTH: '18' }, argv(), 8).depth, 18)
})

test('the name typed on the command line wins over the login name', () => {
  assert.equal(readConfig({ USERNAME: 'login' }, argv('typed'), 8).username, 'typed')
  assert.throws(() => readConfig({}, argv(), 8), /USERNAME is required/)
})

test('colours are checked and kept once each', () => {
  assert.deepEqual(readConfig({ USERNAME: 'p', COLORS: 'black, white,black' }, argv(), 8).colors, [
    'black',
    'white',
  ])
  assert.throws(() => readConfig({ USERNAME: 'p', COLORS: 'blue' }, argv(), 8), /COLORS/)
})

test('stored positions get move counters, full FENs are left alone', () => {
  const stored = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
  assert.equal(searchFen(stored), `${stored} 0 1`)
  assert.equal(searchFen(`${stored} 0 1`), `${stored} 0 1`)
})

test('one upload row per ranked line, keyed on the stored FEN', () => {
  const rows = evaluationItems('fen', {
    lines: [
      { depth: 20, evalCp: 30, evalMate: null, bestMoveUci: 'e2e4', pvUci: 'e2e4 e7e5', multipv: 1 },
      { depth: 20, evalCp: 10, evalMate: null, bestMoveUci: 'd2d4', pvUci: 'd2d4', multipv: 2 },
    ],
  })
  assert.deepEqual(rows.map((row) => [row.fen, row.multipv_rank, row.best_move_uci]), [
    ['fen', 1, 'e2e4'],
    ['fen', 2, 'd2d4'],
  ])
})

test('closing a batcher uploads the rest and waits for uploads still on their way', async () => {
  const sent = []
  let release
  const slow = new Promise((resolve) => (release = resolve))
  const batcher = createBatcher({
    size: 2,
    flush: async (items) => {
      if (!sent.length) await slow
      sent.push(items)
    },
  })
  const first = batcher.push([1, 2])
  await batcher.push([3])
  const closing = batcher.close()
  release()
  await Promise.all([first, closing])
  assert.deepEqual(sent.flat().sort(), [1, 2, 3])
  assert.equal(batcher.pending, 0)
})

function fakeEngine(answer) {
  const engine = {
    searched: [],
    stopped: 0,
    stop() {
      engine.stopped += 1
    },
    async analyse(fen) {
      engine.searched.push(fen)
      return answer(fen)
    },
  }
  return engine
}

const done = (fen) => ({ terminal: false, lines: [{ fen }] })
const quietLog = () => {}

test('a poisoned engine is retired instead of skipping the rest of the queue', async () => {
  const poisoned = fakeEngine(() => {
    throw Object.assign(new Error('engine did not stop'), { fatal: true })
  })
  const sound = fakeEngine(async (fen) => {
    await new Promise((resolve) => setTimeout(resolve, 1))
    return done(fen)
  })
  const results = []
  const outcome = await searchAll(['a', 'b', 'c', 'd'], [poisoned, sound], {
    depth: 20,
    multiPV: 4,
    isStopping: () => false,
    onResult: (fen) => results.push(fen),
    log: quietLog,
  })
  // The poisoned engine lost one position; the sound one searched the rest.
  assert.equal(poisoned.searched.length, 1)
  assert.equal(results.length, 3)
  assert.equal(outcome.searched, 3)
  assert.deepEqual(outcome.engines, [sound])
})

test('a shutdown stops taking work and never stores a cancelled search', async () => {
  let stopping = false
  const engine = fakeEngine((fen) => {
    if (fen.startsWith('b')) {
      stopping = true
      throw Object.assign(new Error('search cancelled'), { cancelled: true })
    }
    return done(fen)
  })
  const results = []
  const taken = []
  const outcome = await searchAll(['a', 'b', 'c'], [engine], {
    depth: 20,
    multiPV: 4,
    isStopping: () => stopping,
    onResult: (fen) => results.push(fen),
    onTaken: (fen) => taken.push(fen),
    log: quietLog,
  })
  assert.deepEqual(results, ['a'])
  assert.deepEqual(taken, ['a', 'b'])
  assert.equal(outcome.left, 1)
  assert.deepEqual(outcome.engines, [engine])
})

test('an ordinary failure skips that position and carries on', async () => {
  const engine = fakeEngine((fen) => {
    if (fen.startsWith('b')) throw new Error('timeout at depth 20')
    return done(fen)
  })
  const results = []
  const outcome = await searchAll(['a', 'b', 'c'], [engine], {
    depth: 20,
    multiPV: 4,
    isStopping: () => false,
    onResult: (fen) => results.push(fen),
    log: quietLog,
  })
  assert.deepEqual(results, ['a', 'c'])
  assert.equal(outcome.left, 0)
})
