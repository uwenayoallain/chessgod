/**
 * Search a player's repertoire positions with MultiPV, so each choice the
 * repertoire makes compares its candidates inside one search.
 *
 *   make repertoire-engine USERNAME=name [COLORS=black,white] [DEPTH=20]
 *
 * It asks `GET /api/training/repertoire` for the positions that still need a
 * MultiPV search (`needs_engine`), searches them with the browser's own
 * Stockfish 19 build, and uploads through `POST /api/analysis/evaluations`
 * exactly as the browser does. A changed move can lead the repertoire into
 * positions it has not judged yet, so it goes round again until nothing is
 * left or a round finds nothing new. It is a one-off job, not a crawler: it
 * runs at nice 19 and stops when the repertoire is judged.
 */

import os from 'node:os'

import { requestJson } from './http.mjs'
import { createEngine } from './sf19.mjs'

const API = process.env.API_URL ?? 'http://localhost:18000'
const USERNAME = process.env.USERNAME ?? process.argv[2]
const COLORS = (process.env.COLORS ?? 'black').split(',').map((color) => color.trim())
const DEPTH = Number(process.env.DEPTH ?? 20)
const MULTIPV = 4
const ENGINES = Math.max(1, Math.min(Number(process.env.ENGINES ?? 2), os.cpus().length - 1))
const MAX_ROUNDS = 5
const UPLOAD_EVERY = 20

if (!USERNAME) {
  console.error('USERNAME is required')
  process.exit(2)
}

const log = (message) => console.log(`${new Date().toISOString()} ${message}`)

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

async function upload(items) {
  for (let start = 0; start < items.length; start += 100) {
    await requestJson(`${API}/api/analysis/evaluations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: items.slice(start, start + 100) }),
      timeoutMs: 60_000,
    })
  }
}

async function main() {
  const engines = await Promise.all(
    Array.from({ length: ENGINES }, () => createEngine({ threads: 1, hash: 128 })),
  )
  const searched = new Set()
  let total = 0
  for (const color of COLORS) {
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      const params = new URLSearchParams({ username: USERNAME, color, fresh: 'true' })
      const repertoire = await requestJson(`${API}/api/training/repertoire?${params}`, {
        timeoutMs: 120_000,
      })
      const work = repertoire.needs_engine.filter((fen) => !searched.has(fen))
      log(`${color} round ${round}: ${work.length} positions to search at depth ${DEPTH}`)
      if (!work.length) break
      let pending = []
      let done = 0
      const queue = [...work]
      await Promise.all(engines.map(async (engine) => {
        while (queue.length) {
          const fen = queue.shift()
          searched.add(fen)
          try {
            const result = await engine.analyse(`${fen} 0 1`, DEPTH, { multiPV: MULTIPV })
            if (!result.terminal) pending.push(...evaluationItems(fen, result))
          } catch (error) {
            log(`skipped ${fen}: ${error.message}`)
          }
          done += 1
          if (pending.length >= UPLOAD_EVERY * MULTIPV) {
            const batch = pending
            pending = []
            await upload(batch)
            log(`${color}: ${done}/${work.length} searched`)
          }
        }
      }))
      if (pending.length) await upload(pending)
      total += work.length
    }
  }
  log(`done: ${total} positions searched`)
  process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
