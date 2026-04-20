import { describe, expect, it } from 'vitest'

import { getStockfishModuleUrl, getStockfishNnueUrl } from './asset-url'

describe('getStockfishModuleUrl', () => {
  it('builds an absolute public URL for the stockfish module', () => {
    expect(getStockfishModuleUrl('http://localhost:5173')).toBe(
      'http://localhost:5173/stockfish/sf_18_smallnet.js',
    )
  })
})

describe('getStockfishNnueUrl', () => {
  it('builds an absolute public URL for the requested nnue file', () => {
    expect(getStockfishNnueUrl('http://localhost:5173', 'nn-4ca89e4b3abf.nnue')).toBe(
      'http://localhost:5173/stockfish/nn-4ca89e4b3abf.nnue',
    )
  })
})
