import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-errors'

export type TheoryMove = {
  san: string
  uci?: string | null
  game_count: number
  win_rate: number | null
}

export type TheoryComparison = {
  fen: string
  user_moves: TheoryMove[]
  master_moves: TheoryMove[]
  eco?: string | null
  opening_name?: string | null
  master_data_state: 'missing' | 'seeded' | 'synced'
}

export type TheoryDeviation = {
  fen: string
  move_number: number
  user_top_move: TheoryMove
  master_top_move: TheoryMove
  eco?: string | null
  opening_name?: string | null
  severity: 'minor' | 'moderate' | 'major'
  representative_game_id?: number | null
  representative_game_ply?: number | null
  representative_post_fen?: string | null
  representative_played_at?: string | null
  representative_user_result?: string | null
}

/** One cache entry per position, shared by the Theory panel, book markers and the sparring opponent. */
export function theoryQuery(fen: string) {
  return {
    queryKey: ['theory', fen] as const,
    queryFn: async ({ signal }: { signal?: AbortSignal }) => {
      const response = await api.get<TheoryComparison>('/api/theory/compare', {
        signal,
        params: { fen },
      })
      return response.data
    },
    staleTime: 10 * 60 * 1000,
  }
}

export function useTheory(fen: string) {
  const query = useQuery({
    ...theoryQuery(fen),
    placeholderData: keepPreviousData,
  })

  const hasData = query.data != null

  return {
    data: query.data ?? null,
    isLoading: query.isLoading && !hasData,
    isRefreshing: query.isFetching && hasData,
    isPlaceholderData: query.isPlaceholderData,
    error: query.error
      ? new Error(getApiErrorMessage(query.error, 'Could not load theory data.'))
      : null,
  }
}

export function useTheoryDeviations(color: 'white' | 'black', minGames = 2) {
  const query = useQuery({
    queryKey: ['theory-deviations', color, minGames],
    queryFn: async ({ signal }) => {
      const response = await api.get<TheoryDeviation[]>('/api/theory/deviations', {
        signal,
        params: { color, min_games: minGames },
      })
      return response.data
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60 * 1000,
  })

  const hasData = query.data != null

  return {
    data: query.data ?? [],
    isLoading: query.isLoading && !hasData,
    isRefreshing: query.isFetching && hasData,
    isPlaceholderData: query.isPlaceholderData,
    error: query.error
      ? new Error(getApiErrorMessage(query.error, 'Could not load theory deviations.'))
      : null,
  }
}
