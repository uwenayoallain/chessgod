/**
 * Search a player's repertoire positions with MultiPV, so each choice the
 * repertoire makes compares its candidates inside one search.
 *
 *   make repertoire-engine USERNAME=name [COLORS=black,white] [DEPTH=20] [ENGINES=2]
 *
 * It asks `GET /api/training/repertoire` for the positions that still need a
 * MultiPV search (`needs_engine`), searches them with the browser's own
 * Stockfish 19 build, and uploads through `POST /api/analysis/evaluations`
 * exactly as the browser does. A changed move can lead the repertoire into
 * positions it has not judged yet, so it goes round again until nothing is
 * left or a round finds nothing new. It is a one-off job, not a crawler: it
 * runs at nice 19 and stops when the repertoire is judged.
 *
 * Stopped with Ctrl-C or SIGTERM, it stops its engines and uploads the
 * searches already finished before it exits; a second signal exits at once.
 */

import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { requestJson } from './http.mjs'
import { createEngine } from './sf19.mjs'
import { uploadEvaluations, uploadWithRetry } from './upload.mjs'

/**
 * Rows shallower than this are never read by the repertoire builder
 * (`MIN_TRUSTED_DEPTH` in backend/app/engine_contract.py), so a search below it
 * would be uploaded and then ignored.
 */
export const MIN_TRUSTED_DEPTH = 18
/**
 * The depth a game review stores (`GAME_REVIEW_DEPTH`), which is also what the
 * course's "Check now" searches at: a move outside the MultiPV lines is judged
 * by differencing against its child's evaluation, which has to sit within
 * `MAX_PAIR_DEPTH_GAP` (2) of this search.
 */
export const DEFAULT_DEPTH = 20
/** The builder compares this many candidate lines (`MULTIPV` there). */
export const MULTIPV = 4
const DEFAULT_ENGINES = 2
const MAX_ROUNDS = 5
const UPLOAD_EVERY = 20
const COLORS = ['black', 'white']

/** A positive whole number from the environment, or `fallback` when unset. */
export function positiveInt(raw, fallback, name) {
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive whole number, not "${raw}"`)
  }
  return value
}

/**
 * The run's settings, checked before any engine starts. Throws with a message
 * the person running it can act on.
 *
 * The username on the command line wins over `USERNAME` in the environment:
 * a desktop session sets that to the login name, which is never what was meant
 * when a name was typed after the script. `make repertoire-engine` already
 * refuses a USERNAME that only came from the environment.
 */
export function readConfig(env = process.env, argv = process.argv, cpuCount = cpus()) {
  const username = argv[2] || env.USERNAME
  if (!username) throw new Error('USERNAME is required')
  const colors = (env.COLORS || 'black')
    .split(',')
    .map((color) => color.trim())
    .filter(Boolean)
  const unknown = colors.filter((color) => !COLORS.includes(color))
  if (!colors.length || unknown.length) {
    throw new Error(`COLORS must be black, white or both, not "${env.COLORS}"`)
  }
  const depth = positiveInt(env.DEPTH, DEFAULT_DEPTH, 'DEPTH')
  if (depth < MIN_TRUSTED_DEPTH) {
    throw new Error(`DEPTH must be at least ${MIN_TRUSTED_DEPTH}: shallower rows are never read`)
  }
  // Leave a core for the machine. On a one-core box that is no core at all,
  // which still means one engine.
  const cap = Math.max(1, Math.floor(cpuCount) - 1)
  const engines = Math.min(positiveInt(env.ENGINES, DEFAULT_ENGINES, 'ENGINES'), cap)
  return {
    api: env.API_URL || 'http://localhost:18000',
    username,
    colors: [...new Set(colors)],
    depth,
    engines,
  }
}

function cpus() {
  // `availableParallelism` never reports zero, where `cpus()` can in a sandbox.
  return typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : Math.max(1, os.cpus().length)
}

/** The FEN to search: positions are stored without move counters. */
export function searchFen(fen) {
  return fen.trim().split(/\s+/).length === 4 ? `${fen} 0 1` : fen
}

/** The upload rows for one search: one row per ranked line, all at its depth. */
export function evaluationItems(fen, result) {
  return result.lines.map((line) => ({
    fen,
    depth: line.depth,
    eval_cp: line.evalCp,
    eval_mate: line.evalMate,
    best_move_uci: line.bestMoveUci,
    pv_uci: line.pvUci,
    multipv_rank: line.multipv,
  }))
}

/**
 * Collects rows and uploads them `size` at a time. `close` uploads whatever is
 * left and waits for every upload still on its way, so nothing finished is
 * dropped when a round, or the whole run, ends early.
 */
export function createBatcher({ size, flush }) {
  let pending = []
  const inFlight = new Set()

  function send() {
    if (!pending.length) return Promise.resolve()
    const batch = pending
    pending = []
    const sending = Promise.resolve()
      .then(() => flush(batch))
      .finally(() => inFlight.delete(sending))
    inFlight.add(sending)
    return sending
  }

  return {
    /** Add rows; resolves true once they are sent, when they filled a batch. */
    async push(items) {
      pending.push(...items)
      if (pending.length < size) return false
      await send()
      return true
    },
    async close() {
      await send()
      await Promise.allSettled([...inFlight])
    },
    get pending() {
      return pending.length
    },
  }
}

/**
 * Search `work` across `engines`, handing each finished search to `onResult`.
 *
 * A search that fails is skipped. One that fails `fatal` (the engine did not
 * stop when told to) also retires its engine: a poisoned engine rejects every
 * later search at once, and left in the loop it would mark the rest of the
 * queue skipped in a moment. A `cancelled` search is a shutdown and is never
 * stored. Resolves with what was searched, what is left, and the engines that
 * are still sound.
 */
export async function searchAll(work, engines, { depth, multiPV, isStopping, onResult, onTaken, log }) {
  const queue = [...work]
  const sound = new Set(engines)
  let searched = 0
  await Promise.all(engines.map(async (engine) => {
    while (queue.length && !isStopping()) {
      const fen = queue.shift()
      onTaken?.(fen)
      let result
      try {
        result = await engine.analyse(searchFen(fen), depth, { multiPV })
      } catch (error) {
        if (error.cancelled || isStopping()) return
        log(`skipped ${fen}: ${error.message}`)
        if (error.fatal) {
          sound.delete(engine)
          log(`an engine stopped answering; ${sound.size} left`)
          return
        }
        continue
      }
      searched += 1
      await onResult(fen, result)
    }
  }))
  return { searched, left: queue.length, engines: engines.filter((engine) => sound.has(engine)) }
}

async function main() {
  let config
  try {
    config = readConfig()
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
  const { api, username, colors, depth } = config
  const log = (message) => console.log(`${new Date().toISOString()} ${message}`)

  let stopping = null
  let engines = []
  const shutdown = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (stopping) {
        log(`${signal} received again, exiting now`)
        process.exit(signal === 'SIGINT' ? 130 : 143)
      }
      stopping = signal
      shutdown.abort()
      log(`${signal} received, stopping the engines and uploading what is finished`)
      // A search stopped short of its depth rejects as cancelled and is never
      // stored; the ones already finished are in the batch, which is flushed.
      for (const engine of engines) engine.stop()
    })
  }
  const isStopping = () => stopping !== null
  const flush = (items) =>
    uploadWithRetry(items, {
      upload: (batch) => uploadEvaluations(api, batch),
      stopping: isStopping,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      busyMs: 5_000,
      maxRetryMs: 60_000,
      log,
    })

  engines = await Promise.all(
    Array.from({ length: config.engines }, () => createEngine({ threads: 1, hash: 128 })),
  )
  const searched = new Set()
  let total = 0
  for (const color of colors) {
    for (let round = 1; round <= MAX_ROUNDS && !isStopping() && engines.length; round += 1) {
      const params = new URLSearchParams({ username, color, fresh: 'true' })
      let repertoire
      try {
        repertoire = await requestJson(`${api}/api/training/repertoire?${params}`, {
          timeoutMs: 120_000,
          signal: shutdown.signal,
        })
      } catch (error) {
        if (isStopping()) break
        throw error
      }
      const work = repertoire.needs_engine.filter((fen) => !searched.has(fen))
      log(`${color} round ${round}: ${work.length} positions to search at depth ${depth}`)
      if (!work.length) break
      const batcher = createBatcher({ size: UPLOAD_EVERY * MULTIPV, flush })
      let done = 0
      const outcome = await searchAll(work, engines, {
        depth,
        multiPV: MULTIPV,
        isStopping,
        log,
        // Taken, not answered: a position that failed is not tried again.
        onTaken: (fen) => searched.add(fen),
        onResult: async (fen, result) => {
          done += 1
          if (result.terminal) return
          if (await batcher.push(evaluationItems(fen, result))) {
            log(`${color}: ${done}/${work.length} searched`)
          }
        },
      })
      await batcher.close()
      total += outcome.searched
      engines = outcome.engines
    }
  }
  if (stopping) {
    log(`stopped: ${total} positions searched and uploaded`)
    process.exit(stopping === 'SIGINT' ? 130 : 143)
  }
  if (!engines.length) {
    log(`every engine stopped answering after ${total} positions`)
    process.exit(1)
  }
  log(`done: ${total} positions searched`)
  process.exit(0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
