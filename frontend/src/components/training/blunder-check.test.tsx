// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Chess } from 'chess.js'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { refreshTrainingQueries } from '@/hooks/use-training'
import { GAME_REVIEW_DEPTH } from '@/lib/analysis/review-depth'
import type { Repertoire, RepertoireLine } from '@/lib/training/types'
import { STARTING_FEN, useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'
import { useTrainingStore } from '@/store/training-store'

import { BlunderCheck } from './blunder-check'
import { HabitsCard, habitsQueryKey } from './habits-card'
import { LineTrainer } from './line-trainer'
import { OpeningCourse } from './opening-course'
import { OpeningRush } from './opening-rush'

const { get, post, threatsOverviewSpy, repertoireState } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  threatsOverviewSpy: vi.fn((_username?: string, _options?: unknown) => ({ data: undefined })),
  repertoireState: {
    white: null as Repertoire | null,
    black: null as Repertoire | null,
  },
}))

vi.mock('@/lib/api', () => ({ api: { get, post } }))
vi.mock('@/lib/sound', () => ({ play: vi.fn() }))
vi.mock('@/components/improvement/drill-continuation', () => ({ DrillContinuation: () => null }))
vi.mock('@/hooks/use-training', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-training')>()),
  useTrainingProfile: () => ({
    data: { threats_spotted: 0, threats_seen: 0, punish_found: 0, punish_seen: 0, rush_best: 0 },
  }),
  useApplyReward: () => vi.fn(),
  useThreatsOverview: (username: string, options?: unknown) =>
    threatsOverviewSpy(username, options),
  useRepertoire: (_username: string, color: 'white' | 'black') => ({
    data: color === 'white' ? repertoireState.white : repertoireState.black,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
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

  it('enables useThreatsOverview only while idle', async () => {
    render(<BlunderCheck username="tester" />)
    expect(threatsOverviewSpy).toHaveBeenLastCalledWith('tester', { enabled: true })

    fireEvent.click(screen.getByRole('button', { name: 'Their mistakes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start Punish it' }))
    await screen.findByText(/Find your move\./)
    expect(threatsOverviewSpy).toHaveBeenLastCalledWith('tester', { enabled: false })
  })
})

describe('refreshTrainingQueries', () => {
  it('skips repertoire-check and training-challenges unless requested', () => {
    const client = new QueryClient()
    const keys = [
      ['training-repertoire', 'tester', 'white'],
      ['threats-overview', 'tester'],
      ['improvement-plan', 'tester', 'both', 'rapid_blitz', null],
      ['week-scoresheet', 'tester', 0],
      ['repertoire-check', 'tester'],
      ['training-challenges', 'tester'],
    ] as const
    for (const key of keys) client.setQueryData(key, { ok: true })

    refreshTrainingQueries(client, 'tester')
    expect(client.getQueryState(['training-repertoire', 'tester', 'white'])?.isInvalidated).toBe(
      true,
    )
    expect(client.getQueryState(['threats-overview', 'tester'])?.isInvalidated).toBe(true)
    expect(
      client.getQueryState(['improvement-plan', 'tester', 'both', 'rapid_blitz', null])
        ?.isInvalidated,
    ).toBe(true)
    expect(client.getQueryState(['week-scoresheet', 'tester', 0])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['repertoire-check', 'tester'])?.isInvalidated).toBe(false)
    expect(client.getQueryState(['training-challenges', 'tester'])?.isInvalidated).toBe(false)

    refreshTrainingQueries(client, 'tester', { full: true })
    expect(client.getQueryState(['repertoire-check', 'tester'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['training-challenges', 'tester'])?.isInvalidated).toBe(true)
    client.clear()
  })
})

describe('OpeningRush timer cleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears the answer pause timeout when the clock expires so it never overwrites the summary board', async () => {
    vi.useFakeTimers()
    const fen1 = STARTING_FEN
    const fen2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -'
    get.mockResolvedValue({
      data: {
        seconds: 1,
        lives: 3,
        questions: [
          {
            fen: fen1,
            side_to_move: 'white',
            color: 'white',
            answer_uci: 'e2e4',
            answer_san: 'e4',
            last_move_uci: null,
            line_name: 'Line 1',
          },
          {
            fen: fen2,
            side_to_move: 'white',
            color: 'white',
            answer_uci: 'g1f3',
            answer_san: 'Nf3',
            last_move_uci: 'e7e5',
            line_name: 'Line 2',
          },
        ],
      },
    })
    post.mockResolvedValue({
      data: { score: 0, best: 1, new_best: false, requeued: 1, xp_gained: 2 },
    })

    render(<OpeningRush username="tester" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start the Rush' }))
    })
    expect(useAppStore.getState().currentFen.startsWith(fen1)).toBe(true)

    // Play a wrong move (starts 1100ms pause timer), then expire the 1000ms rush clock.
    play('d4')
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByLabelText('Opening Rush result')).toBeTruthy()
    const summaryFen = useAppStore.getState().currentFen

    // Advance past the 1100ms wrong-answer pause: question 2 must not load onto the board.
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(useAppStore.getState().currentFen).toBe(summaryFen)
    expect(useAppStore.getState().currentFen.startsWith(fen2)).toBe(false)
  })
})

describe('LineTrainer rollback and restart', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const sampleLine: RepertoireLine = {
    id: 'line-1',
    name: 'King Pawn',
    first_move: 'e4',
    status: 'learning',
    practised: false,
    your_moves: 1,
    known_moves: 0,
    new_moves: 0,
    due_moves: 1,
    recalled_moves: 0,
    games: 5,
    changes: 0,
    traps: 0,
    unchecked: 0,
    moves: [
      {
        ply: 1,
        side: 'you',
        fen: STARTING_FEN,
        san: 'e4',
        uci: 'e2e4',
        status: 'keep',
        reason: 'usual',
        checked: true,
        eval_cp: 20,
        best_eval_cp: 20,
        idea_san: null,
        master_games: 100,
        master_share: 0.5,
        usual_uci: 'e2e4',
        usual_san: 'e4',
        usual_games: 5,
        usual_score: 0.55,
        usual_loss_cp: 0,
        usual_last_played: null,
        games: 5,
        level: 1,
        due: true,
        due_at: null,
        recalled: false,
      },
    ],
  }

  it('rolls back to the asked position even if another move is pushed during the 600ms window, and clears arrows on Restart', () => {
    vi.useFakeTimers()
    render(
      <LineTrainer
        color="white"
        line={sampleLine}
        mode="practice"
        timeClass="rapid_blitz"
        username="tester"
      />,
    )

    // Play a wrong move, then another move within 600ms.
    play('d4')
    play('d5')
    expect(useAppStore.getState().currentFen.startsWith(STARTING_FEN)).toBe(false)

    act(() => {
      vi.advanceTimersByTime(600)
    })
    // The 600ms rollback timer was not cancelled by the second move.
    expect(useAppStore.getState().currentFen.startsWith(STARTING_FEN)).toBe(true)
    expect(useAppStore.getState().trainerArrows).toHaveLength(1)

    // Restart clears trainer arrows and resets state.
    fireEvent.click(screen.getByRole('button', { name: /Restart/ }))
    expect(useAppStore.getState().trainerArrows).toEqual([])
  })
})

describe('OpeningCourse EngineCheck', () => {
  it('searches at GAME_REVIEW_DEPTH and stops the engine when switching colors', async () => {
    let resolveSearch!: (value: null) => void
    const playMoveSpy = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveSearch = resolve
        }),
    )
    const stopSpy = vi.fn()
    useEngineStore.setState({ playMove: playMoveSpy, stop: stopSpy })
    useTrainingStore.setState({ session: null, courseColor: null })

    const makeRepertoire = (color: 'white' | 'black'): Repertoire => ({
      username: 'tester',
      color,
      time_class: 'rapid_blitz',
      min_user_rating: 1000,
      multipv: 4,
      needs_engine: [STARTING_FEN],
      lines: [],
    })
    repertoireState.black = makeRepertoire('black')
    repertoireState.white = makeRepertoire('white')

    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <OpeningCourse username="tester" />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    await waitFor(() =>
      expect(playMoveSpy).toHaveBeenCalledWith(`${STARTING_FEN} 0 1`, {
        depth: GAME_REVIEW_DEPTH,
        multiPV: 4,
      }),
    )

    // Switch repertoire color while the check is running: unmounts the running EngineCheck and stops the engine.
    fireEvent.click(screen.getByRole('button', { name: 'As White' }))
    expect(stopSpy).toHaveBeenCalledOnce()
    resolveSearch(null)
    client.clear()
  })
})

describe('HabitsCard timer cleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears the pending showMoment timeout when unmounted', async () => {
    vi.useFakeTimers()
    const momentFen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -'
    get.mockResolvedValue({ data: { id: 42 } })

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    client.setQueryData(habitsQueryKey('tester'), {
      username: 'tester',
      games: 10,
      pending_games: 0,
      sitting: { active: false, games: 0 },
      habits: [
        {
          key: 'missed_punishment',
          shows: true,
          rate: 0.4,
          count: 4,
          opportunities: 10,
          recent_rate: null,
          recent_count: 0,
          recent_opportunities: 0,
        },
      ],
      last_game: {
        game_id: 42,
        played_at: '2026-09-01T10:00:00Z',
        user_color: 'white',
        user_result: 'loss',
        opponent: 'rival',
        big_mistakes: 1,
        moments: [
          {
            ply: 5,
            habit: 'missed_punishment',
            san: 'd3',
            better_san: 'Nxe5',
            loss_cp: 200,
            fen: momentFen,
          },
        ],
      },
    })
    const onOpenGame = vi.fn()
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <HabitsCard onOpenGame={onOpenGame} username="tester" />
      </QueryClientProvider>,
    )

    const momentButton = screen.getByRole('button', { name: /d3/i })
    await act(async () => {
      fireEvent.click(momentButton)
      await Promise.resolve()
    })
    expect(onOpenGame).toHaveBeenCalledOnce()

    unmount()
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(useAppStore.getState().trainerArrows).toEqual([])
    client.clear()
  })
})
