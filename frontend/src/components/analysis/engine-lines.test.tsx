// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vite-plus/test'

import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'

import { EngineLines } from './engine-lines'

const FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'

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
  render(<EngineLines />)
  expect(screen.getByRole('button', { name: 'c5' })).toBeTruthy()
  expect(screen.getByText('d18')).toBeTruthy()
})
