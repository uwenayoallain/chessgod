import { useMutation, useQuery } from '@tanstack/react-query'
import { isAxiosError } from 'axios'

import { useApplyReward } from '@/hooks/use-training'
import { browserTimeZone } from '@/lib/training/progress'
import { api } from '@/lib/api'

export type Recurrence = 'habit' | 'repeated' | 'one_off'

export type PatternSummary = {
  key: string
  label: string
  positions: number
  occurrences: number
  average_loss_cp: number
  worst_loss_cp: number
  recurrence: Recurrence
  drill_attempts: number
  drill_correct_rate: number | null
  due_positions: number
  learned_positions: number
}

export type DrillMotif = {
  key: 'mate' | 'fork' | 'skewer' | 'pin' | 'back_rank' | 'removing_the_defender'
  label: string
  detail: string
  side: 'allowed' | 'missed'
}

export type DrillIntent = {
  key: string
  label: string
  prompt: string
}

export type DrillFollowUp = {
  fen: string
  opponent_reply_uci: string
  opponent_reply_san: string
  best_move_uci: string
  best_move_san: string
}

export type DrillCard = {
  position_id: number
  fen: string
  side_to_move: 'white' | 'black'
  user_move_san: string
  user_move_uci: string
  best_move_san: string
  best_move_uci: string
  opponent_reply_uci: string | null
  /** The opponent's move that led to `fen`, for the last-move highlight. */
  previous_move_uci?: string | null
  eval_drop_cp: number
  severity: 'inaccuracy' | 'mistake' | 'blunder'
  occurrences: number
  recurrence: Recurrence
  queue_source: 'review' | 'transfer' | 'recent' | 'weak' | 'ranked'
  pattern_key: string
  pattern_label: string
  phase: 'opening' | 'middlegame' | 'endgame'
  explanation: string
  cue: string
  motifs: DrillMotif[]
  follow_up: DrillFollowUp | null
  source_game_id: number
  source_game_url: string
  source_played_at: string
  time_class: string
  clock_seconds_after: number | null
  think_seconds: number | null
  attempts: number
  correct_rate: number | null
  due_at: string | null
}

export type ImprovementPlan = {
  username: string
  color: string
  time_class: string
  min_user_rating: number
  summary: {
    candidate_positions: number
    candidate_positions_is_lower_bound: boolean
    habit_positions: number
    one_off_positions: number
    session_seconds: number
    due_positions: number
    analyzed_decisions: number
    total_decisions: number
    analyzed_by_phase: Array<{
      phase: 'opening' | 'middlegame' | 'endgame'
      analyzed_decisions: number
      share: number
    }>
    coverage_rate: number
    attempts: number
    correct_rate: number | null
    patterns: PatternSummary[]
    insights: Array<{
      key: string
      label: string
      detail: string
      occurrences: number
      sample_games: number
      rate: number
      cue: string
    }>
    opening_priorities: Array<{
      opening_name: string
      time_class: string
      games: number
      score_rate: number
    }>
    trends: Array<{
      key: string
      label: string
      recent_occurrences: number
      previous_occurrences: number
      recent_rate_per_100_games: number
      previous_rate_per_100_games: number
      delta_per_100_games: number
      status: 'improving' | 'worsening' | 'steady' | 'insufficient'
      confidence: 'low' | 'medium' | 'high'
      recent_games: number
      previous_games: number
      recent_analyzed_decisions: number
      previous_analyzed_decisions: number
    }>
    retention: {
      tracked_positions: number
      retained_positions: number
      lapsed_positions: number
      retention_rate: number | null
    }
    results_by_time_class: Array<{
      time_class: string
      games: number
      score_rate: number
      win_rate: number
      draw_rate: number
      loss_rate: number
    }>
    prescription: {
      focus: string
      evidence: string
      action: string
      stop: string
      confidence: 'low' | 'medium' | 'high'
    }
  }
  drills: DrillCard[]
  intents: DrillIntent[]
}

export type DrillAttempt = {
  request_id: string
  username: string
  position_id: number
  expected_move_uci: string
  played_move_uci: string
  pattern_key: string
  intent_key?: string | null
  follow_up_move_uci?: string | null
  expected_follow_up?: DrillFollowUp | null
  response_ms: number
}

export function getTrainingTimeClass(timeClass: string | null) {
  return timeClass === 'rapid' || timeClass === 'blitz' ? timeClass : 'rapid_blitz'
}

export function useImprovementPlan({
  username,
  color,
  timeClass,
  patternKey = null,
  enabled = true,
}: {
  username: string | null
  color: 'white' | 'black' | 'both'
  timeClass: string | null
  patternKey?: string | null
  enabled?: boolean
}) {
  const trainingTimeClass = getTrainingTimeClass(timeClass)
  const query = useQuery({
    enabled: enabled && Boolean(username),
    queryKey: ['improvement-plan', username, color, trainingTimeClass, patternKey],
    queryFn: async ({ signal }) => {
      const response = await api.get<ImprovementPlan>('/api/improvement/plan', {
        signal,
        params: {
          username,
          color,
          time_class: trainingTimeClass,
          pattern_key: patternKey || undefined,
        },
      })
      return response.data
    },
    // Theme switches can retain the library summary; player and game-scope
    // switches must never offer the previous scope's lessons for practice.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === username &&
      previousQuery.queryKey[2] === color &&
      previousQuery.queryKey[3] === trainingTimeClass
        ? previous
        : undefined,
    staleTime: 2 * 60 * 1000,
  })
  const applyReward = useApplyReward(username)
  const attempt = useMutation({
    mutationFn: async (payload: DrillAttempt) => {
      const response = await api.post<{
        correct: boolean
        follow_up_correct: boolean | null
        intent_matched: boolean | null
        intent_feedback: string | null
        xp_gained?: number
      }>('/api/improvement/attempts', { ...payload, tz: browserTimeZone() }, { timeout: 15_000 })
      return response.data
    },
    onSuccess: (result) => {
      void applyReward(
        { xp_gained: result.xp_gained ?? 0 },
        result.correct && result.follow_up_correct !== false ? 'Drill solved' : 'Drill attempted',
      )
      // The reward's refresh covers the plan, at the mutation level, so a
      // completed save refreshes progress even after its trainer unmounts and
      // never delays the grade on the follow-up GET.
    },
    retry: (failureCount, error) =>
      failureCount < 2 && isAxiosError(error) && (!error.response || error.response.status >= 500),
    retryDelay: (attempt) => Math.min(3000, 500 * 2 ** attempt),
  })

  return { ...query, attempt, trainingTimeClass }
}
