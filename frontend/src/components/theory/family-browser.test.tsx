// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { FamilySummary } from '@/hooks/use-families'
import { FamilyBrowser } from './family-browser'

const root: FamilySummary = {
  child_count: 1,
  depth: 0,
  display_name: 'Italian Game',
  eco: 'C50',
  full_name: 'Italian Game',
  id: 1,
  is_main_line: false,
  parent_id: null,
  pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4',
  root_fen: 'italian-fen',
  user_game_count: 4,
  user_win_rate: 0.5,
}

const child: FamilySummary = {
  child_count: 0,
  depth: 1,
  display_name: 'Giuoco Piano',
  eco: 'C53',
  full_name: 'Italian Game: Giuoco Piano',
  id: 2,
  is_main_line: true,
  parent_id: 1,
  pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5',
  root_fen: 'giuoco-fen',
  user_game_count: 2,
  user_win_rate: 0.75,
}

const popularRoot: FamilySummary = {
  ...root,
  child_count: 0,
  display_name: 'Sicilian Defense',
  eco: 'B20',
  full_name: 'Sicilian Defense',
  id: 3,
  root_fen: 'sicilian-fen',
  user_game_count: 18,
}

const quieterChild: FamilySummary = {
  ...child,
  display_name: 'Evans Gambit',
  full_name: 'Italian Game: Evans Gambit',
  id: 4,
  root_fen: 'evans-fen',
  user_game_count: 7,
}

vi.mock('@/hooks/use-families', async () => {
  const actual =
    await vi.importActual<typeof import('@/hooks/use-families')>('@/hooks/use-families')
  return {
    ...actual,
    useFamilies: vi.fn((args: { enabled?: boolean; parentId?: number | null }) => ({
      data:
        args.enabled === false
          ? []
          : args.parentId === 1
            ? [child, quieterChild]
            : [root, popularRoot],
      error: null,
      isLoading: false,
    })),
  }
})

describe('FamilyBrowser', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('expands children and selects the clicked family', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()

    render(<FamilyBrowser color="both" onSelect={onSelect} timeClass={null} username="tester" />)

    expect(screen.queryByText('Giuoco Piano')).toBeNull()

    await user.click(screen.getByLabelText('Expand Italian Game'))
    expect(screen.getByText('Giuoco Piano')).toBeTruthy()

    await user.click(screen.getByText('Giuoco Piano'))
    expect(onSelect).toHaveBeenCalledWith(child)
  })

  it('sorts roots and expanded children by popularity', async () => {
    const user = userEvent.setup()

    render(<FamilyBrowser color="both" onSelect={vi.fn()} timeClass={null} username="tester" />)

    expect(
      screen
        .getByText('Sicilian Defense')
        .compareDocumentPosition(screen.getByText('Italian Game')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    await user.click(screen.getByLabelText('Expand Italian Game'))

    expect(
      screen.getByText('Evans Gambit').compareDocumentPosition(screen.getByText('Giuoco Piano')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })
})
