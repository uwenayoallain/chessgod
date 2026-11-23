// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vite-plus/test'

import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'

import { EngineLines, MAX_PV_CACHE_ENTRIES } from './engine-lines'

const FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
const NEXT_FEN = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -'

afterEach(() => cleanup())

it('shows the lines the engine reports for the board position, read from the store', () => {
  useAppStore.setState({ currentFen: FEN })
  useEngineStore.setState({
    analyzedFen: FEN,
    currentDepth: 18,
    isAnalyzing: false,
    lines: [
      {
        depth: 18,
        seldepth: null,
        multipv: 1,
        score: { type: 'cp', value: -30 },
        nodes: null,
        nps: null,
        time: null,
        pv: ['c7c5', 'g1f3'],
      },
    ],
  })
  const { rerender } = render(<EngineLines />)
  expect(screen.getByRole('button', { name: 'c5' })).toBeTruthy()
  expect(screen.getByText('d18')).toBeTruthy()
  expect(MAX_PV_CACHE_ENTRIES).toBe(200)

  useAppStore.setState({ currentFen: NEXT_FEN })
  useEngineStore.setState({
    analyzedFen: NEXT_FEN,
    currentDepth: 20,
    isAnalyzing: false,
    lines: [
      {
        depth: 20,
        seldepth: null,
        multipv: 1,
        score: { type: 'cp', value: 25 },
        nodes: null,
        nps: null,
        time: null,
        pv: ['g1f3', 'd7d6'],
      },
    ],
  })
  rerender(<EngineLines />)
  expect(screen.getByRole('button', { name: 'Nf3' })).toBeTruthy()
})
