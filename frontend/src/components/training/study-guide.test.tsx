// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vite-plus/test'

import { StudyGuide } from '@/components/training/study-guide'
import type { StudyGuideResponse } from '@/lib/training/study-types'

const mockGuide: StudyGuideResponse = {
  username: 'saint_uwe',
  time_class: 'rapid_blitz',
  player_snapshot: {
    latest_rating: 1695,
    analyzed_decisions: 99088,
    total_decisions: 99474,
    biggest_phase: 'middlegame',
    biggest_phase_share: 0.688,
    top_focus: 'Middlegame Plans, Pawn Structures & Prophylaxis',
  },
  recommended: [
    {
      playbook_id: 'scotch_black',
      priority_score: 112.5,
      reason: 'Repeated opening blunder (Nf6 instead of Qf6 21x, avg -221 cp)',
      evidence: 'Last 12 months: 18 games (4W-2D-12L, 22.2% win / 66.7% loss).',
      metric_label: '12-month loss rate',
      current_value: '66.7%',
      target_value: 'Under 40%',
      trend: 'worsening',
      concrete_fixes: [
        {
          fen: 'r1bqkbnr/pppp1ppp/8/8/3QP3/8/PPP2PPP/RNB1KB1R b KQkq -',
          last_move_uci: 'd1d4',
          opening_name: 'Scotch Game',
          played_san: 'Nf6',
          best_san: 'Qf6',
          occurrences: 21,
          average_loss_cp: 221,
        },
      ],
      playbook: {
        id: 'scotch_black',
        category: 'opening',
        title: 'Neutralizing the Scotch Game (Black)',
        subtitle: 'Fix the 5.Qxd4 trap and counterattack cleanly',
        color: 'black',
        structure_name: 'Open Scotch Center',
        level: '1600-2100',
        tabiya_fen: 'r1bqkbnr/pppp1ppp/8/8/3QP3/8/PPP2PPP/RNB1KB1R b KQkq -',
        tabiya_label: 'Play 5...Qf6! instead of 5...Nf6?',
        summary: 'Active piece play cures the Scotch.',
        core_ideas: ['Play 4...Bc5 or 4...Nf6, or answer 5.Qxd4 with 5...Qf6!.'],
        white_plans: ['Push e5 and castle queenside.'],
        black_plans: ['Challenge d4 immediately and break with ...d5.'],
        key_breaks: ['Black: ...d7-d5'],
        piece_guide: ['Queen belongs on f6 to stop e5.'],
        checklist: ['Never play 5...Nf6? after 5.Qxd4.'],
        common_traps: ['Walking into 6.e5!.'],
        eco_prefixes: ['C45'],
        opening_keywords: ['scotch'],
        books: [
          {
            title: 'Playing 1.e4 e5',
            author: 'GM Nikolaos Ntirlis',
            focus: 'Anti-Scotch middlegame blueprints.',
            level: '1700-2200',
          },
        ],
        courses: [
          {
            title: 'Learn Every Chess Opening (Scotch Game Module)',
            author: 'Chess.com Lessons',
            platform: 'Chess.com Premium',
            source: 'chesscom_premium',
            why: 'Covers Scotch traps and Black counterplay.',
            url: 'https://www.chess.com/lessons',
            level: '1500-2000',
          },
        ],
      },
    },
  ],
  catalog: [],
}

vi.mock('@/hooks/use-study-guide', () => ({
  useStudyGuide: () => ({
    data: mockGuide,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

const mockPlayOut = vi.fn()
vi.mock('@/hooks/use-sparring', () => ({
  useStartSparring: () => ({
    playOut: mockPlayOut,
  }),
}))

describe('StudyGuide', () => {
  it('renders weakness-matched playbooks, concrete fixes, courses, and launches sparring', () => {
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <StudyGuide timeClass="rapid_blitz" username="saint_uwe" />
      </QueryClientProvider>,
    )

    expect(screen.getByText('Neutralizing the Scotch Game (Black)')).toBeTruthy()
    expect(screen.getByText('66.7%')).toBeTruthy()
    expect(screen.getByText('Chess.com Premium')).toBeTruthy()
    expect(screen.getByText('Playing 1.e4 e5')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Play it out vs Stockfish/i }))
    expect(mockPlayOut).toHaveBeenCalledWith({
      fen: 'r1bqkbnr/pppp1ppp/8/8/3QP3/8/PPP2PPP/RNB1KB1R b KQkq -',
      lastUci: null,
      origin: 'Playbook: Neutralizing the Scotch Game (Black)',
    })
  })
})
