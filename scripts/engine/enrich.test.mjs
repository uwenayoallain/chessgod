import test from 'node:test'
import assert from 'node:assert/strict'

import {
  alternativeItems,
  enrichTrainerPositions,
  fetchTrainerFens,
  trainerFensUrl,
} from './enrich.mjs'

const FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'

function line(multipv, move, depth = 20) {
  return {
    depth, evalCp: 20 - multipv, evalMate: null,
    bestMoveUci: move, pvUci: `${move} g1f3`, multipv,
  }
}

const searchResult = {
  depth: 20, evalCp: 19, evalMate: null, bestMoveUci: 'e7e5', pvUci: 'e7e5 g1f3',
  multipv: 1, terminal: false,
  lines: [line(1, 'e7e5'), line(2, 'c7c5'), line(3, 'e7e6')],
}

test('asks for the trainer positions of one player, a few at a time', () => {
  const url = trainerFensUrl('http://backend:8000', 'someone', 6)
  assert.equal(url.pathname, '/api/games/trainer-multipv-fens')
  assert.equal(url.searchParams.get('username'), 'someone')
  assert.equal(url.searchParams.get('limit'), '6')
})

test('reads a missing endpoint or an empty answer as nothing to do', async () => {
  const missing = async () => {
    throw Object.assign(new Error('HTTP 404: Not Found'), { status: 404 })
  }
  assert.equal(await fetchTrainerFens(missing, 'u'), null)
  assert.equal(await fetchTrainerFens(async () => ({ fens: [], review_depth: 20 }), 'u'), null)
  assert.deepEqual(
    await fetchTrainerFens(async () => ({ fens: [FEN], review_depth: 22 }), 'u'),
    { fens: [FEN], reviewDepth: 22 },
  )
  // Any other failure is the backend's, and the caller's outage handling owns it.
  const down = async () => {
    throw Object.assign(new Error('fetch failed'), {})
  }
  await assert.rejects(fetchTrainerFens(down, 'u'), /fetch failed/)
})

test('uploads only the alternatives, never the rank-one answer', () => {
  const items = alternativeItems(FEN, searchResult)
  assert.deepEqual(items.map((item) => item.multipv_rank), [2, 3])
  assert.deepEqual(items.map((item) => item.best_move_uci), ['c7c5', 'e7e6'])
  assert.ok(items.every((item) => item.engine === 'stockfish-19' && item.engine_version === '19'))
  assert.deepEqual(alternativeItems(FEN, { terminal: true, lines: [] }), [])
})

test('searches each position at MultiPV 3 once, and uploads ranks 2 and 3', async () => {
  const searches = []
  const engine = {
    analyse: async (fen, depth, options) => {
      searches.push({ fen, depth, options })
      return searchResult
    },
  }
  const uploads = []
  const done = new Set()
  const other = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -'

  const first = await enrichTrainerPositions({
    fens: [FEN, other], depth: 20, engines: [engine, engine], done,
    upload: async (items) => uploads.push(items),
  })
  assert.deepEqual(first, { searched: 2, uploaded: 4 })
  assert.deepEqual(searches.map((search) => search.options), [{ multiPV: 3 }, { multiPV: 3 }])
  assert.equal(searches[0].fen, `${FEN} 0 1`)
  assert.equal(searches[0].depth, 20)
  assert.ok(uploads.flat().every((item) => item.multipv_rank > 1))

  // Offered again (no second move was stored, say): not searched again.
  const again = await enrichTrainerPositions({
    fens: [FEN], depth: 20, engines: [engine], done,
    upload: async (items) => uploads.push(items),
  })
  assert.deepEqual(again, { searched: 0, uploaded: 0 })
  assert.equal(searches.length, 2)
  assert.equal(uploads.length, 1)
})

test('a failed search is skipped and the rest still upload', async () => {
  let calls = 0
  const engine = {
    analyse: async () => {
      calls += 1
      if (calls === 1) throw new Error('timeout at depth 20')
      return searchResult
    },
  }
  const logged = []
  const uploads = []
  const result = await enrichTrainerPositions({
    fens: ['a', 'b'], depth: 20, engines: [engine], done: new Set(),
    upload: async (items) => uploads.push(items), log: (message) => logged.push(message),
  })
  assert.deepEqual(result, { searched: 1, uploaded: 2 })
  assert.match(logged[0], /timeout at depth 20/)
})

test('stands every engine down mid-batch when the live limit falls to zero', async () => {
  // The crawler's thermal guard trips while two engines are searching.
  let limit = 2
  const searches = []
  const engine = (name) => ({
    analyse: async (fen) => {
      searches.push(`${name}:${fen.split(' ')[0]}`)
      if (searches.length === 2) limit = 0
      return searchResult
    },
  })
  const uploads = []
  const done = new Set()
  const first = await enrichTrainerPositions({
    fens: ['a', 'b', 'c', 'd'], depth: 20, engines: [engine('one'), engine('two')], done,
    liveLimit: () => limit, upload: async (items) => uploads.push(items),
  })
  // Each engine finished the position it had in hand and took no other, and
  // what was searched before the trip is uploaded, not thrown away.
  assert.deepEqual(searches, ['one:a', 'two:b'])
  assert.deepEqual(first, { searched: 2, uploaded: 4 })
  assert.equal(uploads.length, 1)
  // The positions nobody took are not marked done: the next round has them.
  assert.deepEqual([...done], ['a', 'b'])

  limit = 2
  const second = await enrichTrainerPositions({
    fens: ['a', 'b', 'c', 'd'], depth: 20, engines: [engine('one'), engine('two')], done,
    liveLimit: () => limit, upload: async (items) => uploads.push(items),
  })
  assert.deepEqual(second, { searched: 2, uploaded: 4 })
  assert.deepEqual(searches.slice(2), ['one:c', 'two:d'])
})

test('releases only the engines past a partial cut', async () => {
  // Somebody sits down: presence caps the pool at one engine mid-batch.
  let limit = 2
  const searches = []
  const engine = (name) => ({
    analyse: async (fen) => {
      searches.push(`${name}:${fen.split(' ')[0]}`)
      if (searches.length === 2) limit = 1
      return searchResult
    },
  })
  const result = await enrichTrainerPositions({
    fens: ['a', 'b', 'c', 'd'], depth: 20, engines: [engine('one'), engine('two')],
    done: new Set(), liveLimit: () => limit, upload: async () => {},
  })
  assert.deepEqual(searches, ['one:a', 'two:b', 'one:c', 'one:d'])
  assert.deepEqual(result, { searched: 4, uploaded: 8 })
})

test('takes nothing at all when the limit is already zero', async () => {
  const done = new Set()
  let uploaded = false
  const result = await enrichTrainerPositions({
    fens: ['a'], depth: 20, done, liveLimit: () => 0,
    engines: [{ analyse: async () => assert.fail('searched on a machine that had stood down') }],
    upload: async () => { uploaded = true },
  })
  assert.deepEqual(result, { searched: 0, uploaded: 0 })
  assert.equal(done.size, 0)
  assert.equal(uploaded, false)
})

test('rests between positions, and after a skipped one too', async () => {
  const rests = []
  let calls = 0
  const engine = {
    analyse: async () => {
      calls += 1
      if (calls === 2) throw new Error('timeout at depth 20')
      return searchResult
    },
  }
  await enrichTrainerPositions({
    fens: ['a', 'b', 'c'], depth: 20, engines: [engine], done: new Set(),
    restMs: 100, sleep: async (ms) => { rests.push(ms) }, upload: async () => {},
  })
  assert.deepEqual(rests, [100, 100, 100])

  // No pause unless one is asked for: the default costs nothing.
  const unrested = []
  await enrichTrainerPositions({
    fens: ['d'], depth: 20, engines: [engine], done: new Set(),
    sleep: async (ms) => { unrested.push(ms) }, upload: async () => {},
  })
  assert.deepEqual(unrested, [])
})
