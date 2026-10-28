// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { ImprovementPlan } from '@/hooks/use-improvement'
import { STARTING_FEN, useAppStore } from '@/store/app-store'

import { ImprovementTrainer } from './improvement-trainer'

const { mutate, refetch, planState } = vi.hoisted(() => {
  const makePlan = (): ImprovementPlan => ({
    username: 'tester',
    color: 'both',
    time_class: 'rapid_blitz',
    min_user_rating: 1000,
    summary: {
      candidate_positions: 1,
      candidate_positions_is_lower_bound: false,
      habit_positions: 1,
      one_off_positions: 0,
      session_seconds: 40,
      due_positions: 1,
      analyzed_decisions: 20,
      total_decisions: 25,
      analyzed_by_phase: [
        { phase: 'opening' as const, analyzed_decisions: 18, share: 0.9 },
        { phase: 'middlegame' as const, analyzed_decisions: 2, share: 0.1 },
        { phase: 'endgame' as const, analyzed_decisions: 0, share: 0 },
      ],
      coverage_rate: 0.8,
      attempts: 0,
      correct_rate: null,
      patterns: [
        {
          key: 'missed_capture',
          label: 'Missed capture',
          positions: 1,
          occurrences: 2,
          average_loss_cp: 180,
          worst_loss_cp: 180,
          recurrence: 'repeated',
          drill_attempts: 4,
          drill_correct_rate: 0.75,
          due_positions: 1,
          learned_positions: 0,
        },
      ],
      insights: [],
      opening_priorities: [],
      trends: [
        {
          key: 'missed_capture',
          label: 'Missed capture',
          recent_occurrences: 2,
          previous_occurrences: 5,
          recent_rate_per_100_games: 6.7,
          previous_rate_per_100_games: 16.7,
          delta_per_100_games: -10,
          status: 'improving',
          confidence: 'medium',
          recent_games: 30,
          previous_games: 30,
          recent_analyzed_decisions: 80,
          previous_analyzed_decisions: 75,
        },
      ],
      retention: {
        tracked_positions: 3,
        retained_positions: 2,
        lapsed_positions: 1,
        retention_rate: 0.6667,
      },
      results_by_time_class: [
        {
          time_class: 'rapid',
          games: 40,
          score_rate: 0.55,
          win_rate: 0.5,
          draw_rate: 0.1,
          loss_rate: 0.4,
        },
      ],
      prescription: {
        focus: 'Missed capture',
        evidence: '16.7 to 6.7 errors per 100 games.',
        action: 'Check captures first.',
        stop: 'Do not add unrelated study material this week.',
        confidence: 'medium',
      },
    },
    drills: [
      {
        position_id: 7,
        fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -',
        side_to_move: 'white',
        user_move_san: 'd3',
        user_move_uci: 'd2d3',
        best_move_san: 'Nxe5',
        best_move_uci: 'f3e5',
        opponent_reply_uci: 'b8c6',
        previous_move_uci: 'g1f3',
        eval_drop_cp: 180,
        severity: 'mistake',
        occurrences: 2,
        recurrence: 'repeated',
        queue_source: 'transfer',
        pattern_key: 'missed_capture',
        pattern_label: 'Missed capture',
        phase: 'opening',
        explanation: 'd3 lost 1.8 pawns. The stronger move was Nxe5.',
        cue: 'Check captures first.',
        motifs: [
          {
            key: 'fork',
            label: 'Fork',
            detail: 'Nxe5 attacks the king on e8 and the rook on a8 at once.',
            side: 'missed',
          },
        ],
        follow_up: null,
        source_game_id: 4,
        source_game_url: 'https://www.chess.com/game/live/4',
        source_played_at: '2026-09-03T10:00:00Z',
        time_class: 'rapid',
        clock_seconds_after: 18.2,
        think_seconds: 7.4,
        attempts: 0,
        correct_rate: null,
        due_at: null,
      },
    ],
    intents: [
      { key: 'opponent_captures', label: "Opponent's captures", prompt: 'I checked captures.' },
      { key: 'concrete_line', label: 'A concrete line', prompt: 'I calculated one line.' },
    ],
  })
  return { mutate: vi.fn(), refetch: vi.fn(), planState: { current: makePlan(), makePlan } }
})

vi.mock('@/hooks/use-improvement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-improvement')>()),
  useImprovementPlan: () => ({
    data: planState.current,
    isLoading: false,
    attempt: { mutate },
    refetch,
  }),
}))

beforeEach(() => {
  planState.current = planState.makePlan()
})

afterEach(() => {
  cleanup()
  mutate.mockReset()
  refetch.mockReset()
  useAppStore.getState().clearLoadedLine()
})

describe('ImprovementTrainer', () => {
  it('starts at the first position when the next theme has a shorter queue', () => {
    planState.current.drills.push({ ...planState.current.drills[0], position_id: 8 })
    const { rerender } = render(
      <ImprovementTrainer color="both" timeClass="rapid_blitz" username="tester" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Choose Missed capture' }))
    fireEvent.click(screen.getByRole('button', { name: 'Train 2 positions · ~1 min' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show solution' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next position' }))
    expect(screen.getByLabelText('Position 2 of 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show solution' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finish session' }))
    // Two positions given up on: nothing solved first time.
    expect(screen.getByText('0')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to the lessons' }))

    planState.current = planState.makePlan()
    planState.current.drills[0] = {
      ...planState.current.drills[0],
      position_id: 9,
      pattern_key: 'calculation',
      pattern_label: 'Calculation',
    }
    planState.current.summary.patterns[0] = {
      ...planState.current.summary.patterns[0],
      key: 'calculation',
      label: 'Calculation',
    }
    rerender(<ImprovementTrainer color="both" timeClass="rapid_blitz" username="tester" />)
    fireEvent.click(screen.getByRole('button', { name: 'Show all lessons' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose Calculation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Train 1 position · ~1 min' }))
    expect(screen.getByLabelText('Position 1 of 1')).toBeTruthy()
    act(() => useAppStore.getState().pushPosition(STARTING_FEN, 'Nxe5', 'f3e5'))
    expect(mutate.mock.calls[0][0].position_id).toBe(9)
  })

  it.each([null, 'bullet'])(
    'keeps the lesson for equivalent rapid/blitz scope: %s',
    (timeClass) => {
      const { rerender } = render(
        <ImprovementTrainer color="both" timeClass="rapid_blitz" username="tester" />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Choose Missed capture' }))
      fireEvent.click(screen.getByRole('button', { name: 'Train 1 position · ~1 min' }))
      rerender(<ImprovementTrainer color="both" timeClass={timeClass} username="tester" />)
      expect(screen.getByRole('button', { name: 'End drill session' })).toBeTruthy()
      expect(useAppStore.getState().drillSolving).toBe(true)
      act(() => useAppStore.getState().pushPosition(STARTING_FEN, 'Nxe5', 'f3e5'))
      expect(mutate).toHaveBeenCalledOnce()
      expect(mutate.mock.calls[0][0].username).toBe('tester')
    },
  )

  it.each([{ username: 'another-player' }, { color: 'black' as const }, { timeClass: 'rapid' }])(
    'ends the old lesson when its scope changes: %j',
    (change) => {
      const props = { username: 'tester', color: 'both' as const, timeClass: 'rapid_blitz' }
      const { rerender } = render(<ImprovementTrainer {...props} />)
      fireEvent.click(screen.getByRole('button', { name: 'Choose Missed capture' }))
      fireEvent.click(screen.getByRole('button', { name: 'Train 1 position · ~1 min' }))
      expect(useAppStore.getState().drillSolving).toBe(true)

      rerender(<ImprovementTrainer {...props} {...change} />)
      expect(screen.queryByRole('button', { name: 'End drill session' })).toBeNull()
      expect(useAppStore.getState().drillSolving).toBe(false)
      act(() => useAppStore.getState().pushPosition(STARTING_FEN, 'Nxe5', 'f3e5'))
      expect(mutate).not.toHaveBeenCalled()
    },
  )

  it('submits only the first answer while its save is pending', async () => {
    render(<ImprovementTrainer color="both" timeClass="rapid_blitz" username="tester" />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose Missed capture' }))
    fireEvent.click(screen.getByRole('button', { name: 'Train 1 position · ~1 min' }))
    act(() => useAppStore.getState().pushPosition(STARTING_FEN, 'Nxe5', 'f3e5'))
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())

    act(() => useAppStore.getState().pushPosition(STARTING_FEN, 'Nc6', 'b8c6'))
    expect(mutate).toHaveBeenCalledOnce()
    expect(mutate.mock.calls[0][0].played_move_uci).toBe('f3e5')
  })

  it.each([
    ['restart', 'success'],
    ['restart', 'error'],
    ['next', 'success'],
    ['next', 'error'],
    ['retry', 'success'],
    ['retry', 'error'],
  ])('ignores an old %s lesson response: %s', async (transition, response) => {
    if (transition === 'next') {
      planState.current.drills.push({ ...planState.current.drills[0], position_id: 8 })
    }
    render(<ImprovementTrainer color="both" timeClass="rapid_blitz" username="tester" />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose Missed capture' }))
    fireEvent.click(screen.getByRole('button', { name: /Train \d positions? ·/ }))
    act(() => useAppStore.getState().pushPosition(STARTING_FEN, 'Nxe5', 'f3e5'))
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    const oldCallbacks = mutate.mock.calls[0][1]

    if (transition === 'restart') {
      fireEvent.click(screen.getByRole('button', { name: 'End drill session' }))
      fireEvent.click(screen.getByRole('button', { name: /Train \d positions? ·/ }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Show solution' }))
      fireEvent.click(
        screen.getByRole('button', {
          name: transition === 'next' ? 'Next position' : 'Try again',
        }),
      )
    }

    act(() => {
      if (response === 'success')
        oldCallbacks.onSuccess({ correct: true, intent_feedback: 'Old answer feedback' })
      else oldCallbacks.onError(new Error('Old answer failed'))
    })
    expect(screen.queryByText('Found it.')).toBeNull()
    expect(screen.queryByText("Couldn't save that move.")).toBeNull()
    expect(screen.queryByText('Old answer feedback')).toBeNull()
    expect(useAppStore.getState().drillSolving).toBe(true)

    act(() => useAppStore.getState().pushPosition(STARTING_FEN, 'Nxe5', 'f3e5'))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls[1][0].request_id).not.toBe(mutate.mock.calls[0][0].request_id)
    act(() => {
      mutate.mock.calls[1][1].onSuccess({ correct: true })
    })
    expect(screen.getByText('Found it.')).toBeTruthy()
  })

  it('loads a past position and scores the move played on the shared board', async () => {
    mutate.mockImplementation((_payload, callbacks) =>
      callbacks.onSuccess({
        correct: true,
        intent_feedback: 'You were checking captures, which is the right routine.',
      }),
    )
    render(<ImprovementTrainer color="both" timeClass="rapid_blitz" username="tester" />)

    // The scope is stated as one plain line rather than a boxed callout.
    expect(screen.getByText(/rapid and blitz games rated\s*1000\+/)).toBeTruthy()
    expect(screen.getByText('Drills')).toBeTruthy()
    expect(screen.getByText(/0\/1 learned · 1 ready/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Choose Missed capture' }))
    fireEvent.click(screen.getByRole('button', { name: 'Train 1 position · ~1 min' }))
    expect(useAppStore.getState().currentFen).toContain('rnbqkbnr/pppp1ppp')
    // The move being answered is highlighted, without joining the played line.
    expect(useAppStore.getState().nodes.root.uci).toBe('g1f3')
    expect(useAppStore.getState().nodes.root.san).toBeNull()
    // The board must not annotate or arrow the answer while the card is open.
    expect(useAppStore.getState().drillSolving).toBe(true)
    expect(screen.getByText('same position again')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: "Opponent's captures" }))

    act(() => {
      useAppStore.getState().pushPosition(STARTING_FEN, 'Nxe5', 'f3e5')
    })

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          position_id: 7,
          request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          expected_move_uci: 'f3e5',
          played_move_uci: 'f3e5',
          intent_key: 'opponent_captures',
          expected_follow_up: null,
        }),
        expect.any(Object),
      ),
    )
    expect(
      await screen.findByText('You were checking captures, which is the right routine.'),
    ).toBeTruthy()
    expect(await screen.findByText('Found it.')).toBeTruthy()
    expect(useAppStore.getState().drillSolving).toBe(false)
    expect(screen.getByText(/Remember: Check captures first/)).toBeTruthy()
    expect(screen.getByText('Fork')).toBeTruthy()
    expect(screen.getByText(/attacks the king on e8 and the rook on a8/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Finish session' }))
    expect(refetch).toHaveBeenCalledOnce()
    // The set ends on its result before going back to the lessons.
    expect(screen.getByText('Every position solved on the first try.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to the lessons' }))
    expect(screen.getByRole('button', { name: 'Train 1 position · ~1 min' })).toBeTruthy()
  })

  it('hands a resolved drill position to the engine to play out', async () => {
    mutate.mockImplementation((_payload, callbacks) =>
      callbacks.onSuccess({ correct: true, intent_feedback: null }),
    )
    const onPlayOut = vi.fn()
    render(
      <ImprovementTrainer
        color="both"
        onPlayOut={onPlayOut}
        timeClass="rapid_blitz"
        username="tester"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Choose Missed capture' }))
    fireEvent.click(screen.getByRole('button', { name: 'Train 1 position · ~1 min' }))
    // Not offered while the answer is still being looked for.
    expect(screen.queryByRole('button', { name: /Play it out/ })).toBeNull()

    act(() => {
      useAppStore.getState().pushPosition(STARTING_FEN, 'Nxe5', 'f3e5')
    })
    fireEvent.click(await screen.findByRole('button', { name: /Play it out/ }))
    expect(onPlayOut).toHaveBeenCalledWith({
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -',
      lastUci: 'g1f3',
    })
  })

  it('asks for the second move of a calculation drill before scoring it', async () => {
    planState.current.drills[0].follow_up = {
      fen: 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
      opponent_reply_uci: 'b8c6',
      opponent_reply_san: 'Nc6',
      best_move_uci: 'b5c6',
      best_move_san: 'Bxc6',
    }
    const shownFollowUp = planState.current.drills[0].follow_up
    mutate.mockImplementation((_payload, callbacks) => callbacks.onSuccess({ correct: true }))
    const { rerender } = render(
      <ImprovementTrainer color="both" timeClass="rapid_blitz" username="tester" />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Choose Missed capture' }))
    fireEvent.click(screen.getByRole('button', { name: 'Train 1 position · ~1 min' }))
    // Where the reader is, not just how long the drill is.
    expect(screen.getByText('Move 1 of 2')).toBeTruthy()

    act(() => {
      useAppStore.getState().pushPosition(STARTING_FEN, 'Nxe5', 'f3e5')
    })

    // The first move is not scored on its own: the drill continues the line instead.
    expect(mutate).not.toHaveBeenCalled()
    expect(await screen.findByText('Right so far. The opponent answers Nc6.')).toBeTruthy()
    // The step counter has to follow the line, or a two-move drill gives no
    // sign of which move it is waiting for.
    expect(screen.getByText('Move 2 of 2')).toBeTruthy()
    expect(useAppStore.getState().currentFen).toContain('r1bqkbnr/pppp1ppp/2n5/1B2p3')

    // Background refetch changes the server plan, not the lesson already shown.
    planState.current = {
      ...planState.current,
      drills: [{ ...planState.current.drills[0], follow_up: null }],
    }
    rerender(<ImprovementTrainer color="both" timeClass="rapid_blitz" username="tester" />)
    expect(screen.getByText('Right so far. The opponent answers Nc6.')).toBeTruthy()

    act(() => {
      useAppStore.getState().pushPosition(STARTING_FEN, 'Bxc6', 'b5c6')
    })

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          expected_move_uci: 'f3e5',
          played_move_uci: 'f3e5',
          follow_up_move_uci: 'b5c6',
          expected_follow_up: shownFollowUp,
        }),
        expect.any(Object),
      ),
    )
    expect(await screen.findByText('Found it.')).toBeTruthy()
    // The line is rendered ply by ply so the one the reader was asked for can be
    // marked — reading "Nxe5 Nc6 Bxc6" does not say which of those was the ask.
    const line = document.querySelector('.drill-feedback__line')
    expect(
      [...(line?.querySelectorAll('.drill-line__ply') ?? [])].map((n) => n.textContent),
    ).toEqual(['Nxe5', 'Nc6', 'Bxc6'])
    expect(line?.querySelector('.drill-line__ply--asked')?.textContent).toBe('Bxc6')
  })
})
