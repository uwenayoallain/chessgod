// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'

import { DrillContinuation } from './drill-continuation'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get } }))

const FEN = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -'

const originalInit = useEngineStore.getState().init
const originalAnalyze = useEngineStore.getState().analyzePosition

function seed(lines: unknown[]) {
  useEngineStore.setState({
    analysisByFen: lines.length ? { [FEN]: { bestMove: 'g1f3', depth: 22, lines } } : {},
    analysisVersion: Date.now(),
    analyzedFen: null,
    lines: [],
    enabled: true,
    isReady: false,
  } as never)
}

function line(pv: string[], depth = 22, multipv = 1) {
  return {
    depth,
    multipv,
    nodes: null,
    nps: null,
    pv,
    score: { type: 'cp', value: 40 },
    seldepth: null,
    time: null,
  }
}

function plies(container: HTMLElement) {
  return [...container.querySelectorAll('.drill-continuation__ply')].map((n) => n.textContent)
}

describe('DrillContinuation', () => {
  let init: ReturnType<typeof vi.fn>
  let analyzePosition: ReturnType<typeof vi.fn>

  beforeEach(() => {
    get.mockReset()
    get.mockResolvedValue({ data: {} })
    init = vi.fn(async () => {})
    analyzePosition = vi.fn(async () => {})
    useEngineStore.setState({ init, analyzePosition } as never)
  })

  afterEach(() => {
    cleanup()
    useEngineStore.setState({ init: originalInit, analyzePosition: originalAnalyze } as never)
  })

  it('renders a cached line at once, with no request and no engine start', () => {
    seed([line(['g1f3', 'b8c6', 'f1b5'])])
    const { container } = render(<DrillContinuation active fen={FEN} />)
    expect(plies(container)).toEqual(['Nf3', 'Nc6', 'Bb5'])
    expect(get).not.toHaveBeenCalled()
    expect(init).not.toHaveBeenCalled()
    expect(analyzePosition).not.toHaveBeenCalled()
  })

  it('loads the stored line from the server before ever starting the engine', async () => {
    seed([])
    useEngineStore.setState({ isReady: true } as never)
    get.mockResolvedValue({
      data: {
        [FEN]: {
          depth: 22,
          eval_cp: 40,
          eval_mate: null,
          best_move_uci: 'g1f3',
          pv_uci: 'g1f3 b8c6 f1b5',
          multipv_rank: 1,
          engine: 'stockfish-19',
        },
      },
    })

    const { container } = render(<DrillContinuation active fen={FEN} />)

    await waitFor(() => expect(plies(container)).toEqual(['Nf3', 'Nc6', 'Bb5']))
    expect(get).toHaveBeenCalledWith(
      '/api/analysis/evaluations',
      expect.objectContaining({ params: expect.objectContaining({ fens: FEN }) }),
    )
    expect(init).not.toHaveBeenCalled()
    expect(analyzePosition).not.toHaveBeenCalled()
  })

  it('searches in the browser only when the server has nothing stored', async () => {
    seed([])
    useEngineStore.setState({ isReady: true } as never)
    render(<DrillContinuation active fen={FEN} />)
    await waitFor(() =>
      expect(analyzePosition).toHaveBeenCalledWith(
        FEN,
        expect.objectContaining({ priority: 'normal' }),
      ),
    )
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('starts the engine when the server has nothing and the worker is not up', async () => {
    seed([])
    render(<DrillContinuation active fen={FEN} />)
    await waitFor(() => expect(init).toHaveBeenCalled())
    expect(analyzePosition).not.toHaveBeenCalled()
  })

  it('falls back to a search when the server request fails', async () => {
    seed([])
    useEngineStore.setState({ isReady: true } as never)
    get.mockRejectedValue(new Error('offline'))
    render(<DrillContinuation active fen={FEN} />)
    await waitFor(() => expect(analyzePosition).toHaveBeenCalled())
  })

  it('shows the live line of a running search once it is deep enough', async () => {
    seed([])
    get.mockReturnValue(new Promise(() => {}))
    const { container } = render(<DrillContinuation active fen={FEN} />)

    act(() => {
      useEngineStore.setState({ analyzedFen: FEN, lines: [line(['g1f3'], 5)] } as never)
    })
    // Too shallow: still the skeleton.
    expect(plies(container)).toEqual([])

    act(() => {
      useEngineStore.setState({ lines: [line(['g1f3', 'b8c6'], 9)] } as never)
    })
    expect(plies(container)).toEqual(['Nf3', 'Nc6'])
  })

  it('ignores a live search of some other position', () => {
    seed([])
    get.mockReturnValue(new Promise(() => {}))
    useEngineStore.setState({
      analyzedFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
      lines: [line(['e2e4'], 20)],
    } as never)
    const { container } = render(<DrillContinuation active fen={FEN} />)
    expect(plies(container)).toEqual([])
  })

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

    // Scoped to this render's container: these tests share a document.
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
