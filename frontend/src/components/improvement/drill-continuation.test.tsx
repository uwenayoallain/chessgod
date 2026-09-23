// @vitest-environment jsdom

import { fireEvent, render, within } from '@testing-library/react'
import { describe, expect, it } from 'vite-plus/test'

import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'

import { DrillContinuation } from './drill-continuation'

const FEN = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -'

function seed(lines: unknown[]) {
  useEngineStore.setState({
    analysisByFen: { [FEN]: { bestMove: 'g1f3', depth: 22, lines } },
    analysisVersion: Date.now(),
    enabled: true,
    isReady: false,
  } as never)
}

describe('DrillContinuation', () => {
  it('shows the engine line and its evaluation once the drill is done', () => {
    seed([
      {
        depth: 22,
        multipv: 1,
        nodes: null,
        nps: null,
        pv: ['g1f3', 'b8c6', 'f1b5'],
        score: { type: 'cp', value: 40 },
        seldepth: null,
        time: null,
      },
    ])

    const { container } = render(<DrillContinuation active fen={FEN} />)

    expect(
      [...container.querySelectorAll('.drill-continuation__ply')].map((n) => n.textContent),
    ).toEqual(['Nf3', 'Nc6', 'Bb5'])
    expect(container.querySelector('.drill-continuation__eval')?.textContent).toContain('+0.4')
  })

  it('shows nothing at all while the drill is still being solved', () => {
    // The continuation is the answer; it must not appear before the attempt.
    seed([])
    const { container } = render(<DrillContinuation active={false} fen={FEN} />)
    expect(container.querySelector('.drill-continuation')).toBeNull()
  })

  it('reserves its space before the search lands', () => {
    // The line arrives when the search does, so the box has to exist first or
    // the feedback panel grows under the reader.
    seed([])
    const { container } = render(<DrillContinuation active fen={FEN} />)
    expect(container.querySelector('.drill-continuation__body')).not.toBeNull()
    expect(container.querySelector('.drill-continuation__ply')).toBeNull()
  })

  it('prefers the first ranked line when several are cached', () => {
    seed([
      {
        depth: 22,
        multipv: 2,
        nodes: null,
        nps: null,
        pv: ['b1c3'],
        score: { type: 'cp', value: 5 },
        seldepth: null,
        time: null,
      },
      {
        depth: 22,
        multipv: 1,
        nodes: null,
        nps: null,
        pv: ['g1f3'],
        score: { type: 'cp', value: 40 },
        seldepth: null,
        time: null,
      },
    ])

    const { container } = render(<DrillContinuation active fen={FEN} />)
    expect(container.querySelector('.drill-continuation__ply')?.textContent).toBe('Nf3')
  })

  it('jumps the board onto a ply when it is clicked', () => {
    seed([
      {
        depth: 22,
        multipv: 1,
        nodes: null,
        nps: null,
        pv: ['g1f3', 'b8c6'],
        score: { type: 'cp', value: 40 },
        seldepth: null,
        time: null,
      },
    ])

    // Scoped to this render's container — these tests share a document.
    const { container } = render(<DrillContinuation active fen={FEN} />)
    fireEvent.click(within(container).getByLabelText('Show the position after Nc6'))

    const state = useAppStore.getState()
    expect(state.currentFen).toContain('2n5')
    // Rooted with no parent, which is what keeps exploring from being graded as
    // another attempt: the trainer's submit effect requires a parent node.
    expect(state.nodes[state.currentNodeId]?.parentId).toBeFalsy()
  })

  it('marks the ply the board is standing on', () => {
    seed([
      {
        depth: 22,
        multipv: 1,
        nodes: null,
        nps: null,
        pv: ['g1f3', 'b8c6'],
        score: { type: 'cp', value: 40 },
        seldepth: null,
        time: null,
      },
    ])

    const { container } = render(<DrillContinuation active fen={FEN} />)
    fireEvent.click(within(container).getByLabelText('Show the position after Nf3'))

    const current = container.querySelector('.drill-continuation__ply--current')
    expect(current?.textContent).toBe('Nf3')
  })
})
