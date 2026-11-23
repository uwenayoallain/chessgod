/** Bound the UCI handshake after WASM and the verified network are loaded. */
export function readyEngine(engine, { threads, hash, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let waitingReady = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      engine.listen = () => {}
      engine.onError = () => {}
      if (error) reject(Object.assign(error, { fatal: true }))
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('Stockfish readiness handshake timed out')), timeoutMs)
    engine.onError = message => finish(new Error(`Stockfish startup: ${message}`))
    engine.listen = line => {
      if (settled) return
      try {
        if (line === 'uciok' && !waitingReady) {
          waitingReady = true
          engine.uci(`setoption name Threads value ${threads}`)
          engine.uci(`setoption name Hash value ${hash}`)
          engine.uci('setoption name UCI_AnalyseMode value true')
          engine.uci('isready')
        } else if (line === 'readyok' && waitingReady) {
          finish()
        }
      } catch (error) { finish(error) }
    }
    try { engine.uci('uci') } catch (error) { finish(error) }
  })
}
