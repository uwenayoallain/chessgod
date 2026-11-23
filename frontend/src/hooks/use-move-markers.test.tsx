// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vite-plus/test'

import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'
import { useSparStore } from '@/store/spar-store'

import { useMoveMarkers } from './use-move-markers'

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

/** Scoped to this render's container — these tests share a document. */
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
})
