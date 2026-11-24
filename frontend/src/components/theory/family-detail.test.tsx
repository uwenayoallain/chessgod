// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { FamilySummary } from '@/hooks/use-families'
import type { FamilyDetail as Detail } from '@/hooks/use-family-detail'
import { useAppStore } from '@/store/app-store'

import { FamilyDetail } from './family-detail'

const ITALIAN_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3'

const family: FamilySummary = {
  child_count: 0,
  depth: 0,
  display_name: 'Italian Game',
  eco: 'C50',
  full_name: 'Italian Game',
  id: 1,
  is_main_line: false,
  parent_id: null,
  pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4',
  root_fen: ITALIAN_FEN,
  user_game_count: 4,
  user_win_rate: 0.5,
}

const { detail } = vi.hoisted(() => ({ detail: { current: null as unknown } }))

vi.mock('@/hooks/use-family-detail', () => ({
  useFamilyDetail: () => ({
    data: detail.current,
    error: null,
    isLoading: false,
    isRefreshing: false,
    isPlaceholderData: false,
  }),
}))

function show(shown: FamilySummary) {
  detail.current = {
    family: shown,
    ancestors: [],
    children: [],
    position_tree: {
      fen: shown.root_fen,
      total_games: 0,
      white_wins: 0,
      draws: 0,
      black_wins: 0,
      moves: [],
    },
    top_mistakes: [],
  } satisfies Detail
  render(
    <FamilyDetail
      color="both"
      familyId={shown.id}
      onSelectFamily={vi.fn()}
      timeClass={null}
      username="tester"
    />,
  )
}

describe('FamilyDetail', () => {
  const loadPosition = vi.fn()

  beforeEach(() => {
    loadPosition.mockClear()
    useAppStore.setState({ loadPosition })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the opening on the board with the move that reaches it highlighted', () => {
    show(family)

    fireEvent.click(screen.getByText('Show this opening on the board'))

    expect(loadPosition).toHaveBeenCalledWith(ITALIAN_FEN, 'f1c4')
  })

  it('still shows the position when the PGN will not parse', () => {
    show({ ...family, pgn: '1. e4 e5 2. Zz9 nonsense' })

    fireEvent.click(screen.getByText('Show this opening on the board'))

    expect(loadPosition).toHaveBeenCalledWith(ITALIAN_FEN, null)
  })

  it('has no arriving move for an opening with no moves of its own', () => {
    show({ ...family, pgn: '' })

    fireEvent.click(screen.getByText('Show this opening on the board'))

    expect(loadPosition).toHaveBeenCalledWith(ITALIAN_FEN, null)
  })
})
