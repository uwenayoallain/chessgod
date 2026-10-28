// @vitest-environment jsdom

import { Chess } from 'chess.js'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { useAppStore } from '@/store/app-store'

import { BlunderCheck } from './blunder-check'

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('@/lib/api', () => ({ api: { get, post } }))
vi.mock('@/lib/sound', () => ({ play: vi.fn() }))
vi.mock('@/components/improvement/drill-continuation', () => ({ DrillContinuation: () => null }))
vi.mock('@/hooks/use-training', () => ({
  useTrainingProfile: () => ({
    data: { threats_spotted: 0, threats_seen: 0, punish_found: 0, punish_seen: 0 },
  }),
  useApplyReward: () => vi.fn(),
}))

// From the first player's games: 44...Rc1+ hung the rook to Bxc1, and they played Kg2.
const FEN = '6k1/5p1p/Bq1b2pB/5p2/3p4/p2Q3P/5P2/2r3K1 w - -'

function question(id: number) {
  return {
    position_id: id,
    fen: FEN,
    player_color: 'white',
    ply: 89,
    their_move_uci: 'c8c1',
    their_move_san: 'Rc1+',
    your_move_san: 'Kg2',
    kind: 'capture',
    gift_cp: 251,
    game_url: '',
    played_at: '2026-08-02T10:00:00+00:00',
  }
}

function play(san: string) {
  const board = new Chess(
    `${useAppStore.getState().currentFen.split(' ').slice(0, 4).join(' ')} 0 1`,
  )
  const move = board.move(san)
  act(() => {
    useAppStore
      .getState()
      .pushPosition(
        board.fen().split(' ').slice(0, 4).join(' '),
        move.san,
        `${move.from}${move.to}`,
      )
  })
}

beforeEach(() => {
  window.localStorage.clear()
  get.mockResolvedValue({ data: { questions: [question(1), question(2)] } })
  post.mockImplementation(async (_url: string, body: { played_uci: string }) => ({
    data: {
      correct: body.played_uci === 'h6c1',
      answer_uci: 'h6c1',
      answer_san: 'Bxc1',
      your_move_san: 'Kg2',
      xp_gained: body.played_uci === 'h6c1' ? 5 : 1,
    },
  }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Punish it', () => {
  it('plays a set through: asks, scores on the server, and ends on the result', async () => {
    render(<BlunderCheck username="tester" />)
    fireEvent.click(screen.getByRole('button', { name: 'Their mistakes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start Punish it' }))

    await screen.findByText(
      'Your opponent played 44...Rc1+, a mistake. You can win material. Find your move.',
    )
    expect(get).toHaveBeenCalledWith('/api/training/punish', expect.anything())
    // The board is on the position after their mistake, with it highlighted.
    expect(useAppStore.getState().currentFen.startsWith('6k1/5p1p/Bq1b2pB')).toBe(true)
    expect(useAppStore.getState().drillSolving).toBe(true)

    play('Bxc1')
    await screen.findByText('Found: Bxc1. In the game you played Kg2 and gave it back.')
    expect(post).toHaveBeenCalledWith(
      '/api/training/punish/answer',
      expect.objectContaining({ position_id: 1, played_uci: 'h6c1' }),
    )

    fireEvent.click(screen.getByRole('button', { name: /Next position/ }))
    await screen.findByText(/Find your move\./)
    play('Kg2')
    await screen.findByText(/^Kg2 isn't it\. Bxc1 punishes it\./)
    // A miss shows the answer on the board, scoped to the asked position.
    await waitFor(() => expect(useAppStore.getState().trainerArrows).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'See how you did' }))
    await screen.findByText('1 of 2 found. Each one was a gift you handed back in a real game.')
    expect(useAppStore.getState().drillSolving).toBe(false)
  })

  it('remembers the side, so a link from Habits lands on Punish it', () => {
    window.localStorage.setItem('chessgod.blunder-check.mode', 'punish')
    render(<BlunderCheck username="tester" />)
    expect(screen.getByRole('button', { name: 'Start Punish it' })).toBeTruthy()
  })
})
