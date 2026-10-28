import { describe, expect, it } from 'vite-plus/test'

import { getStockfishModuleUrl, getStockfishNnueUrl } from './asset-url'

describe('getStockfishModuleUrl', () => {
  it('builds an absolute public URL for the stockfish module', () => {
    expect(getStockfishModuleUrl('http://localhost:5173')).toBe(
      'http://localhost:5173/stockfish/sf_19.js',
    )
  })
})

describe('getStockfishNnueUrl', () => {
  it('builds an absolute public URL for the requested nnue file', () => {
    expect(getStockfishNnueUrl('http://localhost:5173', 'nn-1a298aa575a0.nnue')).toBe(
      'http://localhost:5173/stockfish/nn-1a298aa575a0.nnue',
    )
  })
})
