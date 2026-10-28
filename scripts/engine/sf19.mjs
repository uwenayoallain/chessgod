/**
 * Headless driver for the same Stockfish 19 build the browser runs.
 *
 * Used by offline measurements and the resource-limited crawler. Both follow
 * the browser's pinned-build, verified-network and exact-score contract.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PINNED_NNUE, verifyNnueBytes } from './nnue.mjs'
import { engineTimeouts } from './timeouts.mjs'
import { readyEngine } from './ready.mjs'

const ASSET_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../frontend/public/stockfish',
)

/** Parse the score from a UCI `info` line, in centipawns from White's side. */
export function parseInfoLine(line, sideToMove) {
  if (/\b(?:lowerbound|upperbound)\b/.test(line)) return null
  const depth = /\bdepth (\d+)/.exec(line)
  const cp = /\bscore cp (-?\d+)/.exec(line)
  const mate = /\bscore mate (-?\d+)/.exec(line)
  const pv = /\bpv (.+)$/.exec(line)
  const multipv = /\bmultipv (\d+)/.exec(line)
  if (!depth || (!cp && !mate)) return null
  // Stockfish reports from the side to move; the database stores White's view.
  const perspective = sideToMove === 'b' ? -1 : 1
  return {
    depth: Number(depth[1]),
    evalCp: cp ? Number(cp[1]) * perspective : null,
    evalMate: mate ? Number(mate[1]) * perspective : null,
    bestMoveUci: pv ? pv[1].split(' ')[0] : null,
    pvUci: pv ? pv[1] : null,
    multipv: multipv ? Number(multipv[1]) : 1,
  }
}

export function finishSearch(best, move, depth) {
  if (move === '(none)' || move === '0000') {
    return { depth, evalCp: null, evalMate: null, bestMoveUci: null, pvUci: null, terminal: true }
  }
  // A legal bestmove with no exact PV is an incomplete search, not evidence
  // of checkmate/stalemate. Never silently classify it as a terminal board.
  if (!best?.bestMoveUci || !best.pvUci) {
    throw new Error('search finished without an exact scored principal variation')
  }
  // A later bound-only line may change the final choice without providing an
  // exact score for it. Do not promote the older scored move to rank-one data.
  if (move !== best.bestMoveUci || move !== best.pvUci.split(/\s+/)[0]) {
    throw new Error('final bestmove does not match the exact scored principal variation')
  }
  return { ...best, terminal: false }
}

export async function createEngine({ threads = 1, hash = 256 } = {}) {
  const { search: SEARCH_TIMEOUT_MS, grace: STOP_GRACE_MS } = engineTimeouts()
  const { default: Sf } = await import(path.join(ASSET_DIR, 'sf_19.js'))
  const engine = await Sf({
    wasmBinary: readFileSync(path.join(ASSET_DIR, 'sf_19.wasm')),
    locateFile: (file) => path.join(ASSET_DIR, file),
    print: () => {},
    printErr: () => {},
  })

  const netName = engine.getRecommendedNnue(0)
  if (netName !== PINNED_NNUE) throw new Error(`Unexpected Stockfish 19 network: ${netName}`)
  // Buffer already implements Uint8Array: avoid another full model-sized copy.
  const netBytes = verifyNnueBytes(netName, readFileSync(path.join(ASSET_DIR, netName)))
  engine.setNnueBuffer(netBytes, 0)

  await readyEngine(engine, { threads, hash })

  let onLine = () => {}
  engine.listen = (line) => onLine(line)
  engine.onError = (message) => {
    throw new Error(`Stockfish: ${message}`)
  }

  // Abandoning a search does not stop the engine. Reject on a timer and the
  // search keeps running, so its `bestmove` lands in the *next* search's
  // handler and that position is stored with another position's evaluation —
  // silently, because the numbers are real, just attached to the wrong board.
  // Seen in the wild: one timeout at depth 34 poisoned every later search on
  // that engine until the server's own validator started rejecting the batch.
  // So: ask the engine to stop, wait for the `bestmove` that proves it has,
  // and tag every search so a straggler from an older one is ignored.
  let generation = 0
  let searching = false
  let poisoned = false

  /**
   * Search one position and resolve with the deepest info line seen.
   *
   * With `multiPV` above one, `lines` holds every ranked line of the last
   * depth the engine completed for all of them, so the candidates are
   * compared inside one search — what a repertoire choice needs.
   */
  function analyse(fen, depth, { multiPV = 1 } = {}) {
    if (poisoned) return Promise.reject(Object.assign(
      new Error('engine did not stop; cannot safely reuse it'), { fatal: true },
    ))
    if (searching) return Promise.reject(new Error('engine already has an active search'))
    searching = true
    const sideToMove = fen.split(' ')[1] ?? 'w'
    const mine = ++generation
    return new Promise((resolve, reject) => {
      let best = null
      const ranked = new Map()
      let timedOut = false
      const softTimer = setTimeout(() => {
        timedOut = true
        engine.uci('stop')
      }, SEARCH_TIMEOUT_MS)
      // UCI output has no search ID. A generation tag on our listener cannot
      // identify late output once a new listener is installed: never reuse a
      // worker that did not acknowledge stop.
      const hardTimer = setTimeout(() => {
        clearTimeout(softTimer)
        poisoned = true
        searching = false
        onLine = () => {}
        reject(Object.assign(new Error(`engine did not stop after ${SEARCH_TIMEOUT_MS}ms at depth ${depth}`), { fatal: true }))
      }, SEARCH_TIMEOUT_MS + STOP_GRACE_MS)

      onLine = (line) => {
        // A straggler from a search we already gave up on.
        if (mine !== generation) return
        if (line.startsWith('info depth')) {
          const info = parseInfoLine(line, sideToMove)
          if (!info) return
          const previous = ranked.get(info.multipv)
          if (!previous || info.depth >= previous.depth) ranked.set(info.multipv, info)
          // Keep the deepest completed line; Stockfish can finish past the ask.
          if (info.multipv === 1 && (!best || info.depth >= best.depth)) best = info
          return
        }
        if (line.startsWith('bestmove')) {
          clearTimeout(softTimer)
          clearTimeout(hardTimer)
          searching = false
          onLine = () => {}
          if (timedOut) {
            // The engine has drained and is idle again, so the next search on
            // it starts clean. This one simply has no trustworthy answer.
            reject(new Error(`timeout at depth ${depth}`))
            return
          }
          const move = line.split(' ')[1]
          try {
            const result = finishSearch(best, move, depth)
            // Only lines searched as deep as the best one belong to its search.
            result.lines = result.terminal
              ? []
              : [...ranked.values()]
                  .filter((info) => info.depth === result.depth && info.pvUci)
                  .sort((a, b) => a.multipv - b.multipv)
            resolve(result)
          } catch (error) {
            reject(error)
          }
        }
      }
      engine.uci(`setoption name MultiPV value ${multiPV}`)
      engine.uci(`position fen ${fen}`)
      engine.uci(`go depth ${depth}`)
    })
  }

  return { analyse, netName }
}
