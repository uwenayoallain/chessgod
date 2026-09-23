/**
 * The database stores every evaluation from White's side of the board.
 *
 * Stockfish reports from the side to move, so a score has to be flipped on
 * Black's move. Getting this wrong is silent: the numbers stay plausible, and
 * every decision by one colour is then graded with its sign inverted, turning
 * that player's best moves into their worst mistakes. Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { finishSearch, parseInfoLine } from './sf19.mjs'

const INFO = 'info depth 22 seldepth 30 multipv 1 score cp 35 nodes 1000 pv e2e4 e7e5'

test('a missing exact score is not a terminal position', () => {
  assert.throws(() => finishSearch(null, 'e2e4', 22), /without an exact/)
  const noPv = parseInfoLine('info depth 22 score cp 35 nodes 1000', 'w')
  assert.throws(() => finishSearch(noPv, 'e2e4', 22), /without an exact/)
})

test('explicit no-move responses mark terminal positions', () => {
  for (const move of ['(none)', '0000']) {
    assert.equal(finishSearch(null, move, 22).terminal, true)
  }
})

test('completed exact evaluations retain their searched depth and PV', () => {
  const exact = parseInfoLine(INFO, 'w')
  const result = finishSearch(exact, 'e2e4', 30)
  assert.equal(result.depth, 22)
  assert.equal(result.pvUci, 'e2e4 e7e5')
  assert.equal(result.terminal, false)
})

test('a final move cannot borrow the score of an older principal variation', () => {
  const exact = parseInfoLine(INFO, 'w')
  assert.throws(() => finishSearch(exact, 'd2d4', 22), /does not match/)
})

test('a missing final move cannot complete a scored search', () => {
  assert.throws(() => finishSearch(parseInfoLine(INFO, 'w'), undefined, 22), /does not match/)
})

test('the stored root move must also agree with the principal variation', () => {
  const inconsistent = { ...parseInfoLine(INFO, 'w'), pvUci: 'd2d4 d7d5' }
  assert.throws(() => finishSearch(inconsistent, 'e2e4', 22), /does not match/)
})

test('a score for White is stored as reported', () => {
  const info = parseInfoLine(INFO, 'w')
  assert.equal(info.depth, 22)
  assert.equal(info.evalCp, 35)
  assert.equal(info.bestMoveUci, 'e2e4')
  assert.equal(info.pvUci, 'e2e4 e7e5')
})

test('a score on Black to move is flipped to White\'s side', () => {
  // Black to move and better: Stockfish says +35 for Black, which is -35 for
  // White, which is what every learning query expects to read.
  assert.equal(parseInfoLine(INFO, 'b').evalCp, -35)
})

test('mate scores are flipped the same way', () => {
  const mate = 'info depth 30 multipv 1 score mate 3 pv d1h5'
  assert.equal(parseInfoLine(mate, 'w').evalMate, 3)
  assert.equal(parseInfoLine(mate, 'b').evalMate, -3)
  assert.equal(parseInfoLine(mate, 'w').evalCp, null)
})

test('a negative score flips sign in both directions', () => {
  const losing = 'info depth 18 multipv 1 score cp -420 pv a2a3'
  assert.equal(parseInfoLine(losing, 'w').evalCp, -420)
  assert.equal(parseInfoLine(losing, 'b').evalCp, 420)
})

test('lines without a score are ignored rather than read as zero', () => {
  assert.equal(parseInfoLine('info depth 1 currmove e2e4 currmovenumber 1', 'w'), null)
  assert.equal(parseInfoLine('info string NNUE evaluation using nn-1a298aa575a0.nnue', 'w'), null)
  assert.equal(parseInfoLine('bestmove e2e4', 'w'), null)
})

for (const bound of ['lowerbound', 'upperbound']) {
  for (const score of ['cp 150', 'mate 3']) {
    test(`${score} ${bound} is not exact learning evidence`, () => {
      const bounded = `info depth 23 multipv 1 score ${score} ${bound} pv g1f3`
      assert.equal(parseInfoLine(bounded, 'w'), null)
      assert.equal(parseInfoLine(bounded, 'b'), null)
    })
  }
}
