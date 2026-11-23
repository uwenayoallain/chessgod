export type EngineWorkerStatus = 'initializing' | 'nnue-loading' | 'nnue-loaded' | 'ready'

export type EngineWorkerCommand =
  | {
      type: 'init'
      hash: number
      threads: number
    }
  | {
      type: 'analyze'
      searchId: number
      fen: string
      depth: number
      multiPV: number
      /**
       * Stop at this many milliseconds even if `depth` is not reached. The
       * search then ends the way a finished one does, with a `bestmove`.
       */
      movetime?: number
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
      searchId: number | null
    }
  | {
      type: 'error'
      message: string
    }
