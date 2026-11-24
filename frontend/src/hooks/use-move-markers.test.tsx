// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { api } from '@/lib/api'
import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'
import { useSparStore } from '@/store/spar-store'

import { useGameReview } from './use-game-line'
import { annotateLine, shareAnnotations } from './use-move-annotations'
import { currentMoveLabel, useMoveMarkers } from './use-move-markers'

afterEach(() => {
  cleanup()
})

/**
 * The hook reads master moves through TanStack Query so the board can mark book
 * moves without a second request. Retries off and no network: with no provider
 * the hook throws, and these tests are about the renderer, not about fetching.
 */
function withQueryClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

/**
 * react-chessboard applies its own `squareStyles` only on the square it
 * renders itself; passing a `squareRenderer` silently drops them. This board
 * always passes one, so the renderer has to carry the styles or the last-move,
 * selection and legal-move markers never paint.
 */
function Harness({ styles }: { styles: Record<string, React.CSSProperties> }) {
  const { squareRenderer } = useMoveMarkers(true, styles)
  return <>{squareRenderer({ piece: null, square: 'e4' })}</>
}

/** Scoped to this render's container; these tests share a document. */
function squareOf(container: HTMLElement) {
  return container.firstElementChild as HTMLElement
}

describe('useMoveMarkers squareRenderer', () => {
  it('paints the square styles it was given', () => {
    const { container } = render(
      withQueryClient(
        <Harness styles={{ e4: { backgroundImage: 'linear-gradient(yellow, yellow)' } }} />,
      ),
    )

    const square = squareOf(container)
    expect(square.style.backgroundImage).toBe('linear-gradient(yellow, yellow)')
    expect(square.style.position).toBe('relative')
  })

  it("paints a trainer's marked square on its own board and nowhere else", () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    act(() => {
      useAppStore.getState().loadPosition(fen)
      useAppStore
        .getState()
        .setTrainerHighlights([{ square: 'e4', color: 'rgb(214, 60, 45)' }], fen)
    })
    const { container, unmount } = render(withQueryClient(<Harness styles={{}} />))
    const mark = container.querySelector<HTMLElement>('[data-marked="e4"]')
    expect(mark?.style.boxShadow).toContain('rgb(214, 60, 45)')
    expect(mark?.style.pointerEvents).toBe('none')
    unmount()

    // Another board: the mark does not follow the player there.
    act(() => useAppStore.getState().pushPosition(`${fen.split(' ')[0]} b KQkq - 0 1`))
    const moved = render(withQueryClient(<Harness styles={{}} />))
    expect(moved.container.querySelector('[data-marked]')).toBeNull()
    moved.unmount()

    // A new tree clears them outright.
    act(() => useAppStore.getState().loadPosition(fen))
    expect(useAppStore.getState().trainerHighlights).toEqual([])
  })

  it('leaves squares with no style of their own alone', () => {
    const { container } = render(withQueryClient(<Harness styles={{}} />))

    const square = squareOf(container)
    expect(square.style.backgroundImage).toBe('')
    expect(square.style.height).toBe('100%')
  })
})

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

function BookHarness({ square }: { square: string }) {
  const { squareRenderer } = useMoveMarkers(true, {})
  return <>{squareRenderer({ piece: null, square })}</>
}

function renderWithBook(square: string, masterMoves: unknown[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  })
  // Seed the cache the Theory panel fills, which is the point of sharing it:
  // marking the board must not cost a second request.
  client.setQueryData(['theory', START], {
    fen: START,
    user_moves: [],
    master_moves: masterMoves,
    master_data_state: 'synced',
  })
  useAppStore.setState({ currentFen: START, drillSolving: false })
  return render(
    <QueryClientProvider client={client}>
      <BookHarness square={square} />
    </QueryClientProvider>,
  )
}

describe('book move markers', () => {
  it('marks the destination square of a master move with its share of the book', () => {
    const { container } = renderWithBook('e4', [
      { san: 'e4', uci: 'e2e4', game_count: 60, win_rate: 0.32 },
      { san: 'd4', uci: 'd2d4', game_count: 40, win_rate: 0.32 },
    ])

    const marker = container.querySelector('.board-book-marker')
    expect(marker?.textContent).toBe('60%')
    expect(marker?.getAttribute('title')).toContain('e4')
  })

  it('leaves squares with no book move unmarked', () => {
    const { container } = renderWithBook('h6', [
      { san: 'e4', uci: 'e2e4', game_count: 60, win_rate: 0.32 },
    ])

    expect(container.querySelector('.board-book-marker')).toBeNull()
  })

  it('does not give away theory while a drill is being solved', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
    })
    client.setQueryData(['theory', START], {
      fen: START,
      user_moves: [],
      master_moves: [{ san: 'e4', uci: 'e2e4', game_count: 60, win_rate: 0.32 }],
      master_data_state: 'synced',
    })
    useAppStore.setState({ currentFen: START, drillSolving: true })

    const { container } = render(
      <QueryClientProvider client={client}>
        <BookHarness square="e4" />
      </QueryClientProvider>,
    )

    expect(container.querySelector('.board-book-marker')).toBeNull()
    useAppStore.setState({ drillSolving: false })
  })

  it('does not show the book during a game against the engine, cached or not', () => {
    // The opponent's own book lookup fills this cache for the position on the
    // board, and a disabled query still returns what is cached.
    useSparStore.setState({ status: 'playing' })
    try {
      const { container } = renderWithBook('e4', [
        { san: 'e4', uci: 'e2e4', game_count: 60, win_rate: 0.32 },
      ])
      expect(container.querySelector('.board-book-marker')).toBeNull()
    } finally {
      useSparStore.setState({ status: 'idle' })
    }
  })

  it('skips fetching /api/theory/compare when solving drills, sparring, or annotations are off', () => {
    const getSpy = vi.spyOn(api, 'get').mockResolvedValue({ data: { master_moves: [] } })
    const uncachedFen = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1'

    function FetchHarness({ showAnnotations }: { showAnnotations: boolean }) {
      useMoveMarkers(showAnnotations, {})
      return null
    }

    useAppStore.setState({ currentFen: uncachedFen, drillSolving: true })
    useSparStore.setState({ status: 'idle' })
    const first = render(withQueryClient(<FetchHarness showAnnotations={true} />))
    expect(getSpy).not.toHaveBeenCalled()
    first.unmount()

    useAppStore.setState({ currentFen: uncachedFen, drillSolving: false })
    useSparStore.setState({ status: 'playing' })
    const second = render(withQueryClient(<FetchHarness showAnnotations={true} />))
    expect(getSpy).not.toHaveBeenCalled()
    second.unmount()

    useSparStore.setState({ status: 'idle' })
    const third = render(withQueryClient(<FetchHarness showAnnotations={false} />))
    expect(getSpy).not.toHaveBeenCalled()
    third.unmount()

    getSpy.mockRestore()
  })
})

describe('guidance arrows', () => {
  const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'

  function ArrowHarness({ onArrows }: { onArrows: (arrows: unknown[]) => void }) {
    const { customArrows } = useMoveMarkers(true, {})
    onArrows(customArrows)
    return null
  }

  function arrowsDrawn() {
    let drawn: unknown[] = []
    render(withQueryClient(<ArrowHarness onArrows={(arrows) => (drawn = arrows)} />))
    return drawn
  }

  it('draws the engine’s move, but not during a game against it', () => {
    useAppStore.setState({ currentFen: AFTER_E4, drillSolving: false })
    useEngineStore.setState({
      analysisByFen: { [AFTER_E4]: { bestMove: 'e7e5', depth: 22, lines: [] } },
    })
    useSparStore.setState({ status: 'idle' })
    expect(arrowsDrawn().length).toBeGreaterThan(0)

    useSparStore.setState({ status: 'playing' })
    expect(arrowsDrawn()).toEqual([])
    useSparStore.setState({ status: 'idle' })
  })

  it('draws what the voice names during a lesson, ahead of the trainer arrows', () => {
    const gold = 'rgba(245, 184, 46, 0.92)'
    const blue = 'rgba(56, 152, 236, 0.88)'
    act(() => {
      useAppStore.getState().loadPosition(AFTER_E4)
      useAppStore.getState().setDrillSolving(true)
      useAppStore.getState().setTrainerArrows([
        { startSquare: 'g8', endSquare: 'f6', color: 'green' },
        { startSquare: 'd7', endSquare: 'd5', color: 'green' },
      ])
      useAppStore.getState().setSpeechOverlay(
        [],
        [
          { startSquare: 'd7', endSquare: 'd5', color: blue },
          { startSquare: 'e7', endSquare: 'e5', color: gold },
        ],
      )
    })
    expect(arrowsDrawn()).toEqual([
      { startSquare: 'd7', endSquare: 'd5', color: blue },
      { startSquare: 'e7', endSquare: 'e5', color: gold },
      { startSquare: 'g8', endSquare: 'f6', color: 'green' },
    ])

    act(() => useAppStore.getState().setSpeechOverlay([], []))
    expect(arrowsDrawn()).toEqual([
      { startSquare: 'g8', endSquare: 'f6', color: 'green' },
      { startSquare: 'd7', endSquare: 'd5', color: 'green' },
    ])
    act(() => {
      useAppStore.getState().setTrainerArrows([])
      useAppStore.getState().setDrillSolving(false)
    })
  })
})

describe('speech marks', () => {
  it('lights the square the voice names over a trainer mark, and leaves with the board', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    act(() => {
      useAppStore.getState().loadPosition(fen)
      useAppStore.getState().setDrillSolving(true)
      useAppStore
        .getState()
        .setTrainerHighlights([{ square: 'e4', color: 'rgb(21, 120, 60)' }], fen)
      useAppStore
        .getState()
        .setSpeechOverlay([{ square: 'e4', color: 'rgba(245, 184, 46, 0.92)' }], [])
    })
    const { container, unmount } = render(withQueryClient(<Harness styles={{}} />))
    // Both layers: the author's mark under, the voice's ring on top of it.
    const marked = container.querySelector<HTMLElement>('[data-marked="e4"]')
    const spoken = container.querySelector<HTMLElement>('[data-spoken="e4"]')
    expect(marked?.style.boxShadow).toContain('rgb(21, 120, 60)')
    expect(spoken?.style.boxShadow).toContain('rgba(245, 184, 46, 0.92)')
    expect(spoken?.style.pointerEvents).toBe('none')
    expect(marked?.compareDocumentPosition(spoken!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    unmount()

    act(() => useAppStore.getState().loadPosition(fen))
    expect(useAppStore.getState().speechHighlights).toEqual([])
    act(() => useAppStore.getState().setDrillSolving(false))
  })

  it('is cleared by every board that replaces the tree', () => {
    const mark = [{ square: 'd4', color: 'gold' }]
    const arrow = [{ startSquare: 'd2', endSquare: 'd4', color: 'gold' }]
    const actions = [
      () => useAppStore.getState().loadReplay([]),
      () => useAppStore.getState().clearLoadedLine(),
      () => useAppStore.getState().resetToStart(),
    ]
    for (const replace of actions) {
      act(() => useAppStore.getState().setSpeechOverlay(mark, arrow))
      act(replace)
      expect(useAppStore.getState().speechHighlights).toEqual([])
      expect(useAppStore.getState().speechArrows).toEqual([])
    }
  })
})

describe('grading a line', () => {
  const E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
  const E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -'
  const NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -'
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'

  function line() {
    return {
      fenHistory: [START_FEN, E4, E5, NF3],
      replayMoves: [
        { ply: 1, san: 'e4', uci: 'e2e4', fen: E4 },
        { ply: 2, san: 'e5', uci: 'e7e5', fen: E5 },
        { ply: 3, san: 'Nf3', uci: 'g1f3', fen: NF3 },
      ],
    }
  }

  function evaluation(cp: number, bestMove: string) {
    return {
      bestMove,
      depth: 22,
      lines: [{ multipv: 1, depth: 22, score: { type: 'cp' as const, value: cp }, pv: [bestMove] }],
    } as never
  }

  it('returns the same array while nothing it read has changed', () => {
    const game = line()
    const analysisByFen = { [START_FEN]: evaluation(20, 'e2e4'), [E4]: evaluation(-20, 'e7e5') }
    const first = annotateLine({ analysisByFen, bookPlies: BOOK, hasLoadedLine: true, line: game })
    const again = annotateLine({ analysisByFen, bookPlies: BOOK, hasLoadedLine: true, line: game })
    expect(again).toBe(first)
    expect(first).toHaveLength(3)
  })

  it('keeps the array when an unrelated position is analysed', () => {
    // A review finishes positions of other games and other branches all the
    // time. The evaluations object is new each time; this line's grades are not.
    const game = line()
    const before = { [START_FEN]: evaluation(20, 'e2e4'), [E4]: evaluation(-20, 'e7e5') }
    const first = annotateLine({
      analysisByFen: before,
      bookPlies: BOOK,
      hasLoadedLine: true,
      line: game,
    })
    const after = { ...before, 'some/other/position w - -': evaluation(300, 'a2a4') }
    const second = annotateLine({
      analysisByFen: after,
      bookPlies: BOOK,
      hasLoadedLine: true,
      line: game,
    })
    expect(second).toBe(first)
  })

  it('replaces only the moves whose grade changed', () => {
    const game = line()
    const before = { [START_FEN]: evaluation(20, 'e2e4'), [E4]: evaluation(-20, 'e7e5') }
    const first = annotateLine({
      analysisByFen: before,
      bookPlies: BOOK,
      hasLoadedLine: true,
      line: game,
    })
    // The position after 2...e5 and the one after 3.Nf3 arrive: move 3 can now
    // be graded, moves 1 and 2 are as they were.
    const after = { ...before, [E5]: evaluation(25, 'g1f3'), [NF3]: evaluation(-25, 'b8c6') }
    const second = annotateLine({
      analysisByFen: after,
      bookPlies: BOOK,
      hasLoadedLine: true,
      line: game,
    })
    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[0])
    expect(second[2]).not.toBe(first[2])
    expect(second[2].bestMove).toBe('g1f3')
  })

  it('shares nothing it should not: a different move is a different object', () => {
    const a = { ply: 1, san: 'e4', uci: 'e2e4', fen: E4, bestMove: null, cpLoss: null, label: null }
    const b = { ...a, label: 'Best' as const }
    const c = { ...a }
    expect(shareAnnotations([a], [b])[0]).toBe(b)
    expect(shareAnnotations([a], [c])).toEqual([a])
    // Every move reused and the same length: the previous array itself.
    const previous = [a]
    expect(shareAnnotations(previous, [c])).toBe(previous)
    // A longer line reuses what it can but is a new array.
    const longer = shareAnnotations(previous, [c, { ...a, ply: 2 }])
    expect(longer).not.toBe(previous)
    expect(longer[0]).toBe(a)
    expect(shareAnnotations(undefined, [c])[0]).toBe(c)
  })
})

const BOOK: number[] = []

describe('what a review tick costs the board', () => {
  const GAME = [
    {
      ply: 1,
      san: 'e4',
      uci: 'e2e4',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -',
    },
    {
      ply: 2,
      san: 'e5',
      uci: 'e7e5',
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -',
    },
  ]

  function finishPosition(fen: string, bestMove: string) {
    // What the engine store does when a review finishes a position: a new
    // evaluations object and a bumped version.
    act(() => {
      useEngineStore.setState((state) => ({
        analysisByFen: { ...state.analysisByFen, [fen]: { bestMove, depth: 22, lines: [] } },
        analysisVersion: state.analysisVersion + 1,
      }))
    })
  }

  it('does not re-render the board for positions it is not showing', () => {
    useSparStore.setState({ status: 'idle' })
    useEngineStore.setState({ analysisByFen: {}, analyzedFen: null, bestMove: null })
    useAppStore.getState().loadReplay(GAME, 1)
    useAppStore.setState({ drillSolving: false })

    let renders = 0
    const renderers = new Set<unknown>()
    function Board() {
      const { squareRenderer } = useMoveMarkers(true, STYLES)
      renders += 1
      renderers.add(squareRenderer)
      return null
    }
    render(withQueryClient(<Board />))
    const settled = renders

    finishPosition('8/8/8/8/8/8/8/K6k w - -', 'a1a2')
    finishPosition('8/8/8/8/8/8/8/K5k1 w - -', 'a1b1')
    finishPosition('8/8/8/8/8/8/8/K4k2 w - -', 'a1b2')

    // Three positions of some other game finished: the hook returned the same
    // string each time, so React had nothing to render and the square renderer
    // (which every one of the 64 squares is drawn with) kept its identity.
    expect(renders).toBe(settled)
    expect(renderers.size).toBe(1)
  })

  it('does follow the position it is showing', () => {
    useSparStore.setState({ status: 'idle' })
    useEngineStore.setState({ analysisByFen: {}, analyzedFen: null, bestMove: null })
    useAppStore.getState().loadReplay(GAME, 1)
    useAppStore.setState({ drillSolving: false })

    let arrows: unknown[] = []
    function Board() {
      arrows = useMoveMarkers(true, STYLES).customArrows
      return null
    }
    render(withQueryClient(<Board />))
    expect(arrows).toEqual([])

    finishPosition(useAppStore.getState().currentFen, 'e7e5')
    expect(arrows.length).toBeGreaterThan(0)
  })
})

const STYLES = {}

describe('the game line while stepping', () => {
  const GAME = [
    {
      ply: 1,
      san: 'e4',
      uci: 'e2e4',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -',
    },
    {
      ply: 2,
      san: 'e5',
      uci: 'e7e5',
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -',
    },
    {
      ply: 3,
      san: 'Nf3',
      uci: 'g1f3',
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -',
    },
  ]

  it('is one object, and one render, for every position of the game', () => {
    useEngineStore.setState({ analysisByFen: {} })
    useAppStore.getState().loadReplay(GAME)

    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useGameReview()
    })
    const loaded = result.current.line
    const graded = result.current.annotations
    expect(loaded.replayMoves).toHaveLength(3)
    const settled = renders

    act(() => useAppStore.getState().goForward())
    act(() => useAppStore.getState().goForward())
    act(() => useAppStore.getState().jumpToIndex(3))
    act(() => useAppStore.getState().resetToStart())

    // The line is keyed on the game's last move, not the cursor: everything a
    // review derives from it is left alone, and the caller is not re-rendered.
    expect(result.current.line).toBe(loaded)
    expect(result.current.annotations).toBe(graded)
    expect(renders).toBe(settled)
  })

  it('becomes the side line once the cursor leaves the game for one', () => {
    useAppStore.getState().loadReplay(GAME, 1)
    const { result } = renderHook(() => useGameReview())
    const game = result.current.line

    act(() =>
      useAppStore
        .getState()
        .pushPosition('rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -', 'c5', 'c7c5'),
    )
    expect(result.current.line).not.toBe(game)
    expect(result.current.line.replayMoves.map((move) => move.san)).toEqual(['e4', 'c5'])
  })
})

describe('the current move’s grade', () => {
  const PARENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
  const CHILD = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
  const node = {
    id: 'n1',
    fen: CHILD,
    san: 'e4',
    uci: 'e2e4',
    ply: 1,
    parentId: 'root',
    children: [],
  }
  const line = {
    fenHistory: [PARENT, CHILD],
    nodeIds: ['n1'],
    replayMoves: [{ ply: 1, san: 'e4', uci: 'e2e4', fen: CHILD }],
  }

  it('is the book mark for a book move on the line', () => {
    expect(
      currentMoveLabel({
        analysisByFen: {},
        bookPlies: [1],
        hasLoadedLine: true,
        line,
        node,
        parentFen: PARENT,
      }),
    ).toBe('Book')
  })

  it('is nothing for the root, which no move produced', () => {
    expect(
      currentMoveLabel({
        analysisByFen: {},
        bookPlies: [],
        hasLoadedLine: false,
        line: { fenHistory: [PARENT], nodeIds: [], replayMoves: [] },
        node: { ...node, id: 'root', san: null, uci: null, ply: 0, parentId: null },
        parentFen: null,
      }),
    ).toBeNull()
  })

  it('is nothing for a move nobody has searched', () => {
    expect(
      currentMoveLabel({
        analysisByFen: {},
        bookPlies: [],
        hasLoadedLine: false,
        line,
        node,
        parentFen: PARENT,
      }),
    ).toBeNull()
  })
})
