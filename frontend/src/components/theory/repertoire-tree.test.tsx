// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { RepertoireNode } from '@/hooks/use-repertoire'
import { useAppStore } from '@/store/app-store'

import { RepertoireTree } from './repertoire-tree'

const { useRepertoireMark, mutateAsync } = vi.hoisted(() => {
  const mutateAsync = vi.fn()
  return { mutateAsync, useRepertoireMark: vi.fn(() => ({ mutateAsync })) }
})

vi.mock('@/hooks/use-repertoire', () => ({ useRepertoireMark }))

function node(san: string, uci: string, fen: string, extra: Partial<RepertoireNode> = {}) {
  return {
    fen,
    move: { san, uci, game_count: 10, win_rate: 0.5 },
    game_count: 10,
    win_rate: 0.5,
    marked: false,
    children: [],
    ...extra,
  } satisfies RepertoireNode
}

const root: RepertoireNode = {
  fen: 'start',
  move: null,
  game_count: 30,
  win_rate: 0.5,
  marked: false,
  children: [
    node('e4', 'e2e4', 'after-e4', {
      children: [
        node('e5', 'e7e5', 'after-e5', {
          marked: true,
          children: [node('Nf3', 'g1f3', 'after-nf3')],
        }),
        node('c5', 'c7c5', 'after-c5'),
      ],
    }),
    node('d4', 'd2d4', 'after-d4'),
  ],
}

/** A request the test settles by hand, so "pending" can be looked at. */
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<null>((done, fail) => {
    resolve = () => done(null)
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('RepertoireTree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mutateAsync.mockResolvedValue(null)
  })

  afterEach(() => {
    cleanup()
  })

  it('mounts one mutation for the whole tree, however many nodes it draws', () => {
    render(<RepertoireTree color="white" root={root} username="tester" />)

    expect(screen.getAllByRole('button', { name: /your repertoire$/ })).toHaveLength(5)
    expect(useRepertoireMark).toHaveBeenCalledTimes(1)
  })

  it('marks a move with its own position, and removes one already marked', async () => {
    render(<RepertoireTree color="black" root={root} username="tester" />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add c5 to your repertoire' }))
    })
    expect(mutateAsync).toHaveBeenLastCalledWith({
      username: 'tester',
      fen: 'after-c5',
      color: 'black',
      intended_move_uci: 'c7c5',
      intended_move_san: 'c5',
      remove: false,
    })

    const marked = screen.getByRole('button', { name: 'Remove e5 from your repertoire' })
    expect(marked.getAttribute('aria-pressed')).toBe('true')
    await act(async () => {
      fireEvent.click(marked)
    })
    expect(mutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ fen: 'after-e5', intended_move_uci: 'e7e5', remove: true }),
    )
  })

  it('holds only the buttons whose request is still out', async () => {
    const first = deferred()
    const second = deferred()
    mutateAsync.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    render(<RepertoireTree color="white" root={root} username="tester" />)
    const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })

    fireEvent.click(button('Add c5 to your repertoire'))
    expect(button('Add c5 to your repertoire').disabled).toBe(true)
    expect(button('Add d4 to your repertoire').disabled).toBe(false)

    // A second mark while the first is in flight must not release the first.
    fireEvent.click(button('Add d4 to your repertoire'))
    expect(button('Add c5 to your repertoire').disabled).toBe(true)
    expect(button('Add d4 to your repertoire').disabled).toBe(true)

    await act(async () => {
      first.resolve()
    })
    expect(button('Add c5 to your repertoire').disabled).toBe(false)
    expect(button('Add d4 to your repertoire').disabled).toBe(true)

    // A failed request gives the button back too.
    await act(async () => {
      second.reject(new Error('offline'))
    })
    expect(button('Add d4 to your repertoire').disabled).toBe(false)
    expect(mutateAsync).toHaveBeenCalledTimes(2)
  })

  it('shows a move on the board with the move that reaches it', () => {
    const loadPosition = vi.fn()
    useAppStore.setState({ loadPosition })
    render(<RepertoireTree color="white" root={root} username="tester" />)

    fireEvent.click(screen.getByText('Nf3'))

    expect(loadPosition).toHaveBeenCalledWith('after-nf3', 'g1f3')
  })
})
