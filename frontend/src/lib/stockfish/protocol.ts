export type EngineWorkerStatus = 'initializing' | 'nnue-loading' | 'nnue-loaded' | 'ready'

export type EngineWorkerCommand =
  | {
      type: 'init'
      hash: number
      threads: number
    }
  | {
      type: 'analyze'
      fen: string
      depth: number
      multiPV: number
    }
  | {
      type: 'stop'
    }

export type EngineWorkerEvent =
  | {
      type: 'status'
      status: EngineWorkerStatus
    }
  | {
      type: 'line'
      line: string
    }
  | {
      type: 'error'
      message: string
    }
