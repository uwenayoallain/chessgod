import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readyEngine } from './ready.mjs'

test('handshake configures the engine before accepting readiness', async () => {
  const commands = []
  const engine = { uci(command) {
    commands.push(command)
    if (command === 'uci') {
      this.listen('readyok') // Unsolicited readiness cannot skip configuration.
      this.listen('uciok')
    }
    if (command === 'isready') this.listen('readyok')
  } }
  await readyEngine(engine, { threads: 2, hash: 96, timeoutMs: 100 })
  assert.deepEqual(commands, ['uci', 'setoption name Threads value 2',
    'setoption name Hash value 96', 'setoption name UCI_AnalyseMode value true', 'isready'])
})

for (const acknowledgesUci of [false, true]) {
  test(`missing ${acknowledgesUci ? 'readyok' : 'uciok'} fails within a bounded handshake`, async () => {
    const engine = { uci(command) {
      if (acknowledgesUci && command === 'uci') this.listen('uciok')
    } }
    await assert.rejects(readyEngine(engine, { threads: 1, hash: 32, timeoutMs: 20 }),
      error => error.fatal === true && /timed out/.test(error.message))
    assert.doesNotThrow(() => engine.listen('readyok'))
  })
}

for (const viaCallback of [true, false]) {
  test(`startup ${viaCallback ? 'error callback' : 'command exception'} rejects instead of hanging`, async () => {
    const engine = { uci() {
      if (viaCallback) this.onError('worker failed')
      else throw new Error('worker failed')
    } }
    await assert.rejects(readyEngine(engine, { threads: 1, hash: 32, timeoutMs: 100 }),
      error => error.fatal === true && /worker failed/.test(error.message))
  })
}
