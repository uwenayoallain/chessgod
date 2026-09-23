import { afterEach, expect, it, vi } from 'vite-plus/test'

import { StockfishEngine } from './engine'
import type { EngineWorkerCommand, EngineWorkerEvent } from './protocol'

class FakeWorker {
  static instance: FakeWorker
  onmessage: ((event: { data: EngineWorkerEvent }) => void) | null = null
  commands: EngineWorkerCommand[] = []
  constructor() {
    FakeWorker.instance = this
  }
  postMessage(command: EngineWorkerCommand) {
    this.commands.push(command)
  }
  terminate() {}
  emit(data: EngineWorkerEvent) {
    this.onmessage?.({ data })
  }
  latestSearch() {
    const command = this.commands.filter((item) => item.type === 'analyze').at(-1)
    if (!command) throw new Error('No search')
    return command.searchId
  }
}

afterEach(() => vi.unstubAllGlobals())

it.each(['0000', '(none)'])('normalizes the terminal UCI move %s', (move) => {
  vi.stubGlobal('Worker', FakeWorker)
  const onBestMove = vi.fn()
  const engine = new StockfishEngine({
    onInfo: vi.fn(),
    onBestMove,
    onReady: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
  })
  engine.analyze('terminal')
  const worker = FakeWorker.instance
  worker.emit({ type: 'line', line: `bestmove ${move}`, searchId: worker.latestSearch() })
  expect(onBestMove).toHaveBeenCalledExactlyOnceWith(null)
})

it('rejects late results even when their moves are legal in the newly requested position', () => {
  vi.stubGlobal('Worker', FakeWorker)
  const callbacks = {
    onInfo: vi.fn(),
    onBestMove: vi.fn(),
    onReady: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
  }
  const engine = new StockfishEngine(callbacks)
  engine.analyze('position-a')
  const worker = FakeWorker.instance
  const first = worker.latestSearch()
  engine.analyze('position-b')
  const second = worker.latestSearch()
  const line = 'info depth 22 score cp 30 pv e2e4'
  worker.emit({ type: 'line', line, searchId: first })
  worker.emit({ type: 'line', line: 'bestmove e2e4', searchId: first })
  expect(callbacks.onInfo).not.toHaveBeenCalled()
  expect(callbacks.onBestMove).not.toHaveBeenCalled()
  worker.emit({ type: 'line', line, searchId: second })
  expect(callbacks.onInfo).toHaveBeenCalledTimes(1)
  engine.stop()
  worker.emit({ type: 'line', line: 'bestmove e2e4', searchId: second })
  expect(callbacks.onBestMove).not.toHaveBeenCalled()
  engine.analyze('position-b')
  expect(worker.latestSearch()).not.toBe(second)
  worker.emit({ type: 'line', line: 'bestmove d2d4', searchId: worker.latestSearch() })
  expect(callbacks.onBestMove).toHaveBeenCalledExactlyOnceWith('d2d4')
})

it('does not create an expensive worker merely to stop an idle engine', () => {
  const Worker = vi.fn()
  vi.stubGlobal('Worker', Worker)
  new StockfishEngine({
    onInfo: vi.fn(),
    onBestMove: vi.fn(),
    onReady: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
  }).stop()
  expect(Worker).not.toHaveBeenCalled()
})

it('hands a sparring search’s lines to the caller, never to analysis', async () => {
  vi.stubGlobal('Worker', FakeWorker)
  const callbacks = {
    onInfo: vi.fn(),
    onBestMove: vi.fn(),
    onReady: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
  }
  const engine = new StockfishEngine(callbacks)
  const lines = engine.play('sparring', { depth: 4, multiPV: 3 })
  const worker = FakeWorker.instance
  const command = worker.commands.at(-1)
  if (command?.type !== 'analyze') throw new Error('Expected a search')
  expect(command).toMatchObject({ fen: 'sparring', depth: 4, multiPV: 3 })
  const id = command.searchId
  worker.emit({ type: 'line', line: 'info depth 3 multipv 1 score cp 10 pv g8f6', searchId: id })
  worker.emit({
    type: 'line',
    line: 'info depth 4 multipv 1 score cp 30 pv g8f6 b1c3',
    searchId: id,
  })
  worker.emit({ type: 'line', line: 'info depth 4 multipv 2 score cp -45 pv e7e5', searchId: id })
  worker.emit({ type: 'line', line: 'bestmove g8f6', searchId: id })
  const result = await lines
  // The final line per candidate, in rank order.
  expect(result?.map((line) => [line.multipv, line.depth, line.score.value, line.pv[0]])).toEqual([
    [1, 4, 30, 'g8f6'],
    [2, 4, -45, 'e7e5'],
  ])
  // A shallow search is not an evaluation and must never be cached or uploaded.
  expect(callbacks.onInfo).not.toHaveBeenCalled()
  expect(callbacks.onBestMove).not.toHaveBeenCalled()
})

it('settles a superseded sparring search with nothing', async () => {
  vi.stubGlobal('Worker', FakeWorker)
  const engine = new StockfishEngine({
    onInfo: vi.fn(),
    onBestMove: vi.fn(),
    onReady: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
  })
  const stopped = engine.play('a', { depth: 4, multiPV: 8 })
  engine.stop()
  await expect(stopped).resolves.toBeNull()
  const superseded = engine.play('b', { depth: 4, multiPV: 8 })
  engine.analyze('c')
  await expect(superseded).resolves.toBeNull()
})
