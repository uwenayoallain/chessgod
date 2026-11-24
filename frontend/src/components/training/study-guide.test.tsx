// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { finalPosition, moveLabels } from '@/components/training/study-course-trainer'
import {
  firstLessonLine,
  fullFen,
  practiceQueue,
  StudyGuide,
} from '@/components/training/study-guide'
import type {
  MasterPlaybook,
  StudyCourseDetail,
  StudyCourseLine,
  StudyCoursesListResponse,
  StudyGuideResponse,
} from '@/lib/training/study-types'
import { clearSpeechCache, getSpeechState, stopSpeech } from '@/lib/speech'
import { useAppStore } from '@/store/app-store'

const { get, post, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get, post, delete: del } }))
vi.mock('@/lib/sound', () => ({ play: vi.fn() }))

const mockApplyReward = vi.fn()
vi.mock('@/hooks/use-training', () => ({ useApplyReward: () => mockApplyReward }))

const mockPlayOut = vi.fn()
vi.mock('@/hooks/use-sparring', () => ({
  useStartSparring: () => ({ playOut: mockPlayOut }),
}))

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
const AFTER_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -'
const SCOTCH = 'r1bqkbnr/pppp1ppp/8/8/3QP3/8/PPP2PPP/RNB1KB1R b KQkq -'

const line: StudyCourseLine = {
  id: 'line-1',
  title: 'Italian: main line',
  start_fen: START,
  moves: [
    {
      ply: 1,
      fen: START,
      san: 'e4',
      uci: 'e2e4',
      side: 'you',
      comment: 'Take the centre.',
      arrows: [{ from: 'd2', to: 'd4', color: 'blue' }],
      highlights: [{ square: 'e5', color: 'red' }],
    },
    {
      ply: 2,
      fen: AFTER_E4,
      san: 'e5',
      uci: 'e7e5',
      side: 'opponent',
      comment: 'Black mirrors.',
      arrows: [],
      highlights: [],
    },
    {
      ply: 3,
      fen: AFTER_E5,
      san: 'Nf3',
      uci: 'g1f3',
      side: 'you',
      comment: 'Attack e5.',
      arrows: [],
      highlights: [],
    },
  ],
  your_moves: 2,
  known_moves: 1,
  due_moves: 1,
  status: 'due',
}

/** The player's copy of the Open Games course: one line, one move due. */
const openGamesCourse: StudyCourseDetail = {
  id: 7,
  title: 'Open Games Starter',
  color: 'white',
  source_type: 'builtin',
  source_ref: 'open-games',
  description: 'Annotated 1.e4 e5 lines.',
  chapter_count: 1,
  line_count: 1,
  your_moves: 2,
  known_moves: 1,
  due_moves: 1,
  created_at: '2026-11-20T10:00:00Z',
  chapters: [{ id: 1, position: 1, title: 'Italian Game', start_fen: START, lines: [line] }],
}

/** The Scotch course, not added yet: Start learning adds it first. */
const scotchCourse: StudyCourseDetail = {
  ...openGamesCourse,
  id: 11,
  title: 'Scotch Defense Pack',
  source_ref: 'scotch-defense',
  known_moves: 0,
  due_moves: 0,
  chapters: [
    {
      id: 2,
      position: 1,
      title: 'Meeting 4.Nxd4',
      start_fen: START,
      lines: [
        {
          ...line,
          id: 'scotch-1',
          title: 'Scotch: 5...Qf6',
          known_moves: 0,
          due_moves: 0,
          status: 'new',
        },
      ],
    },
  ],
}

const listing: StudyCoursesListResponse = {
  courses: [openGamesCourse],
  presets: [],
}

const openGames: MasterPlaybook = {
  id: 'open_games',
  category: 'opening',
  title: 'Open Games for White',
  subtitle: 'Italian and Scotch ideas',
  color: 'white',
  structure_name: 'Open centre',
  level: '1200-1800',
  tabiya_fen: null,
  tabiya_label: null,
  summary: 'Fast development and central control.',
  core_ideas: ['Develop toward the centre.'],
  white_plans: [],
  black_plans: [],
  key_breaks: [],
  piece_guide: [],
  checklist: [],
  common_traps: [],
  eco_prefixes: ['C50'],
  opening_keywords: ['italian'],
  books: [],
  courses: [],
  course_preset_id: 'open-games',
}

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
        course_preset_id: 'scotch-defense',
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
  catalog: [openGames],
}

/** HTMLAudioElement as far as the voice uses it; jsdom cannot play media. */
class FakeAudio {
  static instances: FakeAudio[] = []
  src: string
  paused = true
  currentTime = 0
  plays = 0
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
  }
  play() {
    this.paused = false
    this.plays += 1
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
}

function ttsCalls() {
  return post.mock.calls.filter(([url]) => url === '/api/study/tts/narrate')
}

/** The narrated clip: the voice names e4 and draws e2 to e4 for its first five seconds. */
const narration = {
  audio_base64: btoa('mp3'),
  mime_type: 'audio/mpeg',
  voice: 'en-US-AvaNeural',
  spoken_text: 'e4 pawn.',
  cues: [
    {
      start_ms: 0,
      end_ms: 5000,
      squares: ['e4'],
      arrows: [{ from: 'e2', to: 'e4', color: 'gold' }],
      color: 'gold',
    },
  ],
}

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const reviewResponse = {
  line_id: 'line-1',
  recalled: 2,
  missed: 0,
  total: 2,
  known_moves: 2,
  due_moves: 0,
  status: 'learning',
  reward: { xp_gained: 12 },
}

beforeEach(() => {
  get.mockImplementation((url: string) =>
    Promise.resolve({
      data:
        url === '/api/study/guide'
          ? mockGuide
          : url === '/api/study/courses'
            ? listing
            : url === '/api/study/courses/11'
              ? scotchCourse
              : openGamesCourse,
    }),
  )
  post.mockImplementation((url: string) =>
    Promise.resolve({
      data:
        url === '/api/study/tts/narrate'
          ? narration
          : url === '/api/study/courses/import'
            ? scotchCourse
            : reviewResponse,
    }),
  )
  FakeAudio.instances = []
  vi.stubGlobal('Audio', FakeAudio)
  URL.createObjectURL = vi.fn(() => 'blob:clip')
  URL.revokeObjectURL = vi.fn()
  useAppStore.getState().loadPosition(`${START} 0 1`)
})

afterEach(() => {
  cleanup()
  stopSpeech()
  clearSpeechCache()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  vi.clearAllMocks()
  vi.useRealTimers()
})

function renderGuide(props: Partial<Parameters<typeof StudyGuide>[0]> = {}) {
  return render(wrap(<StudyGuide timeClass="rapid_blitz" username="saint_uwe" {...props} />))
}

async function openLibraryCard() {
  fireEvent.click(await screen.findByRole('button', { name: /All Playbooks/ }))
  fireEvent.click(screen.getByRole('button', { name: /Open Games for White/ }))
  // The card's course is looked up from the player's courses.
  await screen.findByRole('button', { name: 'Review due (1)' })
}

describe('study helpers', () => {
  it('completes a four-field FEN and keeps a full one', () => {
    expect(fullFen(SCOTCH)).toBe(`${SCOTCH} 0 1`)
    expect(fullFen(`${SCOTCH} 3 5`)).toBe(`${SCOTCH} 3 5`)
  })

  it('numbers moves from the line start and finds the final position', () => {
    expect(moveLabels(line)).toEqual(['1.', '1...', '2.'])
    const end = finalPosition(line)
    expect(end.lastUci).toBe('g1f3')
    expect(end.fen.startsWith('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b')).toBe(true)
  })

  it('learns new lines first and practises due lines first', () => {
    const mastered = { ...line, id: 'm', status: 'mastered' as const, due_moves: 0 }
    const learning = { ...line, id: 'l', status: 'learning' as const, due_moves: 0 }
    const due = { ...line, id: 'd', status: 'due' as const, due_moves: 1 }
    const fresh = { ...line, id: 'n', status: 'new' as const, due_moves: 0 }
    expect(firstLessonLine([mastered, learning, due, fresh])?.id).toBe('n')
    expect(firstLessonLine([mastered, learning, due])?.id).toBe('d')
    expect(firstLessonLine([mastered, learning])?.id).toBe('l')
    expect(firstLessonLine([mastered])?.id).toBe('m')
    expect(firstLessonLine([])).toBeUndefined()
    expect(practiceQueue([fresh, learning, due]).map((l) => l.id)).toEqual(['d'])
    expect(practiceQueue([fresh, learning, mastered]).map((l) => l.id)).toEqual(['l', 'm'])
    expect(practiceQueue([fresh]).map((l) => l.id)).toEqual(['n'])
  })
})

describe('StudyGuide', () => {
  it('opens on the weaknesses with two tabs and no course importer', async () => {
    renderGuide()
    const weaknesses = await screen.findByRole('button', { name: /For your weaknesses/ })
    expect(weaknesses.getAttribute('aria-pressed')).toBe('true')
    const tabs = screen.getByRole('group', { name: 'Study Guide view' })
    expect([...tabs.querySelectorAll('button')].map((tab) => tab.textContent)).toEqual([
      'For your weaknesses (1)',
      'All Playbooks (1)',
    ])
    expect(screen.queryByRole('button', { name: /Interactive Courses|My Courses/ })).toBeNull()
    expect(screen.queryByLabelText('Lichess study URL')).toBeNull()
    expect(screen.queryByRole('button', { name: /Load structure on board/ })).toBeNull()
    expect(screen.getByText('Neutralizing the Scotch Game (Black)')).toBeTruthy()
    expect(screen.getByText('66.7%')).toBeTruthy()
    expect(screen.getByText('Chess.com Premium')).toBeTruthy()
    expect(screen.getByText('Playing 1.e4 e5')).toBeTruthy()
  })

  it('adds the course and runs its first lesson inline from a weakness card', async () => {
    const onBeginDrill = vi.fn()
    renderGuide({ onBeginDrill })
    fireEvent.click(await screen.findByRole('button', { name: 'Start learning' }))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/study/courses/import', {
        preset_id: 'scotch-defense',
        username: 'saint_uwe',
      }),
    )
    expect(await screen.findByText('Take the centre.')).toBeTruthy()
    expect(screen.getByText('Scotch: 5...Qf6')).toBeTruthy()
    expect(onBeginDrill).toHaveBeenCalledTimes(1)
    expect(
      useAppStore.getState().trainerArrows.map((arrow) => `${arrow.startSquare}${arrow.endSquare}`),
    ).toContain('e2e4')

    fireEvent.click(screen.getByRole('button', { name: /Back to Playbooks/ }))
    expect(await screen.findByText('Neutralizing the Scotch Game (Black)')).toBeTruthy()
  })

  it('shows course progress on the card and starts Practice on the due lines', async () => {
    renderGuide()
    await openLibraryCard()
    expect(screen.getByText('1 due')).toBeTruthy()
    expect(
      screen
        .getByRole('progressbar', { name: /Open Games for White/ })
        .getAttribute('aria-valuenow'),
    ).toBe('50')

    fireEvent.click(screen.getByRole('button', { name: 'Review due (1)' }))
    expect(await screen.findByText('Your move, from memory.')).toBeTruthy()
    expect(post).not.toHaveBeenCalledWith('/api/study/courses/import', expect.anything())
  })

  it('browses chapters and starts any line in Learn or Practice', async () => {
    renderGuide()
    await openLibraryCard()
    fireEvent.click(screen.getByRole('button', { name: /Browse chapters & lines/ }))
    expect(await screen.findByText('Italian: main line')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Practice Italian: main line' }))
    expect(await screen.findByText('Your move, from memory.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Back to Playbooks/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Learn Italian: main line' }))
    expect(await screen.findByText('Take the centre.')).toBeTruthy()
  })

  it('adds a course that is not added yet when its chapters are browsed', async () => {
    renderGuide()
    fireEvent.click(await screen.findByRole('button', { name: /Browse chapters & lines/ }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/study/courses/import', {
        preset_id: 'scotch-defense',
        username: 'saint_uwe',
      }),
    )
  })

  it('learns a line on the board, scores it, and plays it out', async () => {
    const onPlayOut = vi.fn()
    renderGuide({ onPlayOut })
    await openLibraryCard()
    fireEvent.click(screen.getByRole('button', { name: 'Start learning' }))

    // Learn mode shows the comment, the author's marks and the move arrow.
    expect(await screen.findByText('Take the centre.')).toBeTruthy()
    expect(
      useAppStore.getState().trainerArrows.map((arrow) => `${arrow.startSquare}${arrow.endSquare}`),
    ).toEqual(['d2d4', 'e2e4'])
    // The author's marked square is painted on the board, for this position only.
    expect(useAppStore.getState().trainerHighlights.map((mark) => mark.square)).toEqual(['e5'])
    expect(useAppStore.getState().trainerHighlightsFen).toBe(START)

    vi.useFakeTimers({ shouldAdvanceTime: true })
    act(() => useAppStore.getState().pushPosition(`${AFTER_E4} 0 1`, 'e4', 'e2e4'))
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(await screen.findByText('Black mirrors.', { exact: false })).toBeTruthy()

    act(() =>
      useAppStore
        .getState()
        .pushPosition(
          'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
          'Nf3',
          'g1f3',
        ),
    )
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/api/study/courses/7/review',
        expect.objectContaining({
          username: 'saint_uwe',
          line_id: 'line-1',
          mode: 'learn',
          moves: [
            { fen: START, expected_uci: 'e2e4', played_uci: 'e2e4', hinted: false },
            { fen: AFTER_E5, expected_uci: 'g1f3', played_uci: 'g1f3', hinted: false },
          ],
          tz: expect.any(String),
          daily_goal: expect.any(Number),
        }),
      ),
    )
    expect(await screen.findByText('2 / 2')).toBeTruthy()
    // The pass earns XP, celebrated like any other line.
    expect(await screen.findByText('+12 XP')).toBeTruthy()
    expect(mockApplyReward).toHaveBeenCalledWith({ xp_gained: 12 }, 'Italian: main line')

    // Step back to the first move: its position, its comment and its marks.
    expect(screen.getByText('Attack e5.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '1. e4' }))
    expect(screen.getByText('Take the centre.')).toBeTruthy()
    expect(useAppStore.getState().currentFen.startsWith(AFTER_E4)).toBe(true)
    expect(useAppStore.getState().trainerHighlights.map((mark) => mark.square)).toEqual(['e5'])
    expect(
      useAppStore.getState().trainerArrows.map((arrow) => `${arrow.startSquare}${arrow.endSquare}`),
    ).toEqual(['d2d4'])
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Black mirrors.', { exact: false })).toBeTruthy()
    expect(useAppStore.getState().trainerHighlights).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: /Play it out vs Stockfish/ }))
    expect(onPlayOut).toHaveBeenCalledWith(
      expect.objectContaining({
        lastUci: 'g1f3',
        origin: 'Course: Open Games Starter, Italian: main line',
      }),
    )
  })

  it('takes back a wrong move in practice and asks for the right one', async () => {
    renderGuide()
    await openLibraryCard()
    fireEvent.click(screen.getByRole('button', { name: 'Review due (1)' }))
    expect(await screen.findByText('Your move, from memory.')).toBeTruthy()
    expect(useAppStore.getState().trainerArrows).toEqual([])

    act(() =>
      useAppStore
        .getState()
        .pushPosition('rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1', 'd4', 'd2d4'),
    )
    expect((await screen.findAllByText('Not d4. Play e4.')).length).toBeGreaterThan(0)
    await waitFor(() =>
      expect(useAppStore.getState().trainerArrows.map((arrow) => arrow.endSquare)).toContain('e4'),
    )
    expect(screen.getByText('Take the centre.')).toBeTruthy()
  })

  it('plays the tabiya out against Stockfish as a full FEN', async () => {
    renderGuide()
    fireEvent.click(await screen.findByRole('button', { name: /Play it out vs Stockfish/i }))
    expect(mockPlayOut).toHaveBeenCalledWith({
      fen: `${SCOTCH} 0 1`,
      lastUci: null,
      origin: 'Playbook: Neutralizing the Scotch Game (Black)',
    })
  })

  it('analyzes the tabiya and inspects a fix as full FENs after clearing the loaded game', async () => {
    const onBeginDrill = vi.fn()
    const onOpenExplore = vi.fn()
    renderGuide({ onBeginDrill, onOpenExplore })

    fireEvent.click(await screen.findByRole('button', { name: 'Analyze position' }))
    expect(onBeginDrill).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().currentFen).toBe(`${SCOTCH} 0 1`)
    expect(onOpenExplore).toHaveBeenCalledWith('explore-engine')

    useAppStore.getState().loadPosition(`${START} 0 1`)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    expect(onBeginDrill).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().currentFen).toBe(`${SCOTCH} 0 1`)
  })

  it('reads a playbook aloud, pauses and resumes it, and stops when its card closes', async () => {
    renderGuide()
    const listen = await screen.findByRole('button', { name: 'Listen to explanation' })
    expect(listen.getAttribute('aria-pressed')).toBe('false')

    // The open card fetched its voice already, so Listen asks for nothing more.
    await waitFor(() => expect(ttsCalls()).toHaveLength(1))
    const body = ttsCalls()[0][1] as { text: string; side?: string }
    expect(body.text).toContain('Active piece play cures the Scotch.')
    expect(body.text).toContain('Core ideas.')
    expect(body.text.length).toBeLessThanOrEqual(1150)
    expect(body.side).toBe('black')
    expect(getSpeechState().status).toBe('idle')

    fireEvent.click(listen)
    const pause = await screen.findByRole('button', { name: 'Pause voice' })
    expect(ttsCalls()).toHaveLength(1)
    expect(pause.getAttribute('aria-pressed')).toBe('true')
    const clip = FakeAudio.instances[0]
    expect(clip.paused).toBe(false)

    // Pause holds the clip where it is; Resume carries on from there.
    clip.currentTime = 2.5
    fireEvent.click(pause)
    expect(clip.paused).toBe(true)
    const resume = await screen.findByRole('button', { name: 'Resume voice' })
    expect(resume.getAttribute('title')).toBe('Resume')
    expect(screen.getByRole('button', { name: 'Restart voice' }).getAttribute('title')).toBe(
      'Start over',
    )
    expect(screen.getByText('Active piece play cures the Scotch.')).toBeTruthy()
    fireEvent.click(resume)
    await screen.findByRole('button', { name: 'Pause voice' })
    expect(clip.paused).toBe(false)
    expect(clip.currentTime).toBe(2.5)
    expect(FakeAudio.instances).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Restart voice' })).toBeNull()

    // Start over rewinds the same clip.
    fireEvent.click(screen.getByRole('button', { name: 'Pause voice' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restart voice' }))
    await screen.findByRole('button', { name: 'Pause voice' })
    expect(clip.currentTime).toBe(0)
    expect(clip.paused).toBe(false)
    expect(ttsCalls()).toHaveLength(1)

    // Collapsing the card takes the voice with it.
    fireEvent.click(screen.getByRole('button', { name: /Neutralizing the Scotch Game/ }))
    expect(clip.paused).toBe(true)
    expect(getSpeechState()).toEqual({ activeId: null, status: 'idle', activeCues: [] })
  })

  it('narrates a lesson with Auto-read, lights what she names, and goes quiet when it closes', async () => {
    renderGuide()
    await openLibraryCard()
    fireEvent.click(screen.getByRole('button', { name: 'Start learning' }))
    expect(await screen.findByText('Take the centre.')).toBeTruthy()

    const auto = screen.getByRole('button', { name: /Auto-read/ })
    expect(auto.getAttribute('aria-pressed')).toBe('false')
    expect(FakeAudio.instances).toHaveLength(0)

    // Looking ahead: this move's prompt and the next two steps' comments are
    // fetched for White before anything is played.
    await waitFor(() =>
      expect(ttsCalls().map(([, body]) => body)).toEqual(
        expect.arrayContaining([
          { text: '1. e4. Take the centre.', side: 'white' },
          { text: '1... e5. Black mirrors.', side: 'white' },
          { text: '2. Nf3. Attack e5.', side: 'white' },
        ]),
      ),
    )
    const asked = (text: string) =>
      ttsCalls().filter(([, body]) => (body as { text: string }).text === text).length

    fireEvent.click(auto)
    expect(auto.getAttribute('aria-pressed')).toBe('true')
    expect(window.localStorage.getItem('chessgod.study.autoRead')).toBe('true')
    expect(await screen.findByRole('button', { name: 'Pause voice' })).toBeTruthy()
    // Played straight from the prefetched clip, which was asked for once.
    expect(asked('1. e4. Take the centre.')).toBe(1)
    expect(getSpeechState().activeId).toBe('study:line-1:prompt:0')

    // The lesson hides every hint, but what the voice names is on the board.
    expect(useAppStore.getState().drillSolving).toBe(true)
    await waitFor(() =>
      expect(useAppStore.getState().speechHighlights).toEqual([
        { square: 'e4', color: 'rgba(245, 184, 46, 0.92)' },
      ]),
    )
    expect(useAppStore.getState().speechArrows).toEqual([
      { startSquare: 'e2', endSquare: 'e4', color: 'rgba(245, 184, 46, 0.92)' },
    ])

    fireEvent.click(screen.getByRole('button', { name: /Back to Playbooks/ }))
    expect(await screen.findByText('Open Games for White')).toBeTruthy()
    expect(FakeAudio.instances[0].paused).toBe(true)
    expect(getSpeechState()).toEqual({ activeId: null, status: 'idle', activeCues: [] })
    expect(useAppStore.getState().speechHighlights).toEqual([])
  })
})
