import { describe, expect, it } from 'vite-plus/test'

import {
  buildUciSearchCommands,
  chooseEngineMode,
  completeReplayJob,
  handleReplayTimeout,
  enqueueAnalysisJob,
  type AnalysisJob,
} from './analysis-policy'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'

function job(overrides: Partial<AnalysisJob>): AnalysisJob {
  return {
    fen: START_FEN,
    depth: 20,
    mode: 'standard',
    multiPV: 2,
    source: 'interactive',
    ...overrides,
  }
}

describe('Stockfish analysis policy', () => {
  it('uses a fast quick pass for changed current positions before standard analysis', () => {
    expect(chooseEngineMode({ requestedDepth: 22, source: 'interactive', stable: false })).toEqual({
      depth: 18,
      mode: 'quick',
      multiPV: 1,
    })

    expect(chooseEngineMode({ requestedDepth: 22, source: 'interactive', stable: true })).toEqual({
      depth: 22,
      mode: 'standard',
      multiPV: 2,
    })
  })

  it('keeps background replay jobs single-PV even at deeper depths', () => {
    expect(chooseEngineMode({ requestedDepth: 22, source: 'replay', stable: true })).toEqual({
      depth: 22,
      mode: 'background',
      multiPV: 1,
    })
  })

  it('places current-position jobs ahead of replay work and replaces stale current jobs', () => {
    const queue = [
      job({ fen: AFTER_E4, source: 'replay', mode: 'background', multiPV: 1 }),
      job({ fen: START_FEN, source: 'interactive', mode: 'quick', depth: 14, multiPV: 1 }),
    ]

    expect(
      enqueueAnalysisJob(queue, job({ fen: AFTER_E4, source: 'interactive', mode: 'standard' })),
    ).toEqual([
      job({ fen: AFTER_E4, source: 'interactive', mode: 'standard' }),
      job({ fen: AFTER_E4, source: 'replay', mode: 'background', multiPV: 1 }),
    ])
  })

  it('always counts replay jobs as completed to prevent stuck queues', () => {
    expect(completeReplayJob({ completed: 2, total: 5 })).toEqual({
      active: true,
      completed: 3,
      total: 5,
    })

    expect(completeReplayJob({ completed: 4, total: 5 })).toEqual({
      active: false,
      completed: 5,
      total: 5,
    })
  })

  it('moves past replay timeouts that produced usable partial analysis', () => {
    expect(handleReplayTimeout({ attempts: 0, maxRetries: 2, reachedDepth: 19 })).toEqual({
      complete: true,
      retry: false,
    })
  })

  it('retries replay timeouts that produced no usable analysis', () => {
    expect(handleReplayTimeout({ attempts: 0, maxRetries: 2, reachedDepth: 0 })).toEqual({
      complete: false,
      retry: true,
    })
  })

  it('orders UCI tuning commands before searching a position', () => {
    expect(
      buildUciSearchCommands({
        depth: 20,
        fen: START_FEN,
        hash: 256,
        multiPV: 2,
        threads: 3,
      }),
    ).toEqual([
      'setoption name Threads value 3',
      'setoption name Hash value 256',
      'setoption name MultiPV value 2',
      `position fen ${START_FEN}`,
      'go depth 20',
    ])
  })
})
