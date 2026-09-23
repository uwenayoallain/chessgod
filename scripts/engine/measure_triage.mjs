/**
 * Does a shallow search predict what a deep one would have said?
 *
 * The crawl's cost is set by its depth, and the library is far too large to
 * search all of it at review depth. A two-stage cascade — search everything
 * cheaply, then re-search only what looks like a mistake — is only sound if the
 * cheap stage almost never misses a real one. This measures that on real
 * decisions from the library rather than assuming it.
 *
 * Usage: node scripts/engine/measure_triage.mjs <sample.json> [shallow] [deep]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createEngine } from './sf19.mjs'

const [samplePath, shallowArg, deepArg] = process.argv.slice(2)
const SHALLOW = Number(shallowArg ?? 12)
const DEEP = Number(deepArg ?? 22)
const MATE_CP = 2000

/** The stored six-field form; positions are kept without clocks. */
const fullFen = (fen) => (fen.trim().split(/\s+/).length === 6 ? fen : `${fen} 0 1`)

/** Mate scores are ordered against centipawns the way the learning SQL does. */
const toCp = ({ evalCp, evalMate }) => {
  if (evalCp != null) return evalCp
  if (evalMate == null) return null
  return evalMate > 0
    ? MATE_CP - Math.min(evalMate, 20) * 10
    : -MATE_CP + Math.min(-evalMate, 20) * 10
}

const decisions = JSON.parse(readFileSync(samplePath, 'utf8'))
const { analyse, netName } = await createEngine({ threads: 4, hash: 256 })
process.stderr.write(`net ${netName}: ${decisions.length} decisions at depth ${SHALLOW} and ${DEEP}\n`)

const rows = []
let elapsed = { shallow: 0, deep: 0 }
for (const [index, decision] of decisions.entries()) {
  const row = { ...decision }
  for (const [label, depth] of [['shallow', SHALLOW], ['deep', DEEP]]) {
    const started = Date.now()
    const parent = await analyse(fullFen(decision.parent_fen), depth)
    const child = await analyse(fullFen(decision.child_fen), depth)
    elapsed[label] += Date.now() - started
    const parentCp = toCp(parent)
    const childCp = toCp(child)
    row[`${label}_parent_cp`] = parentCp
    row[`${label}_child_cp`] = childCp
    row[`${label}_best`] = parent.bestMoveUci
    row[`${label}_child_terminal`] = child.terminal
    // The child position is scored after the move, so a loss for White is the
    // parent minus the child; for Black the reverse.
    row[`${label}_cp_loss`] =
      parentCp == null || childCp == null
        ? null
        : decision.user_color === 'white' ? parentCp - childCp : childCp - parentCp
  }
  rows.push(row)
  if ((index + 1) % 10 === 0) process.stderr.write(`  ${index + 1}/${decisions.length}\n`)
}

writeFileSync(process.env.TRIAGE_OUT ?? 'triage-results.json', JSON.stringify({
  shallow_depth: SHALLOW, deep_depth: DEEP, net: netName,
  shallow_seconds: Math.round(elapsed.shallow / 1000),
  deep_seconds: Math.round(elapsed.deep / 1000),
  rows,
}, null, 2))
process.stderr.write(`shallow ${Math.round(elapsed.shallow / 1000)}s, deep ${Math.round(elapsed.deep / 1000)}s\n`)
process.exit(0)
