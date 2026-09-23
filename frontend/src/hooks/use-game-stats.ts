import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'

export type ColorStats = {
  wins: number
  losses: number
  draws: number
}

export type OpeningStat = {
  opening_name: string
  games: number
}

export type TimeClassStats = {
  games: number
  wins: number
  losses: number
  draws: number
  win_rate: number
}

export type GameStats = {
  total_games: number
  win_rate: number
  by_color: { white: ColorStats; black: ColorStats }
  by_time_class: Record<string, TimeClassStats>
  by_opening: OpeningStat[]
}

export function useGameStats(
  username: string | null,
  refreshKey: string | number = 0,
  timeClass: string | null = null,
) {
  const query = useQuery({
    enabled: Boolean(username),
    queryKey: ['game-stats', username, timeClass, refreshKey],
    queryFn: async ({ signal }) => {
      const response = await api.get<GameStats>('/api/games/stats', {
        signal,
        params: { username, time_class: timeClass ?? undefined },
      })
      return response.data
    },
    placeholderData: keepPreviousData,
    staleTime: refreshKey === 0 ? 5 * 60 * 1000 : 0,
  })

  const hasData = query.data != null

  return {
    data: query.data ?? null,
    isLoading: query.isLoading && !hasData,
    isRefreshing: query.isFetching && hasData,
    isPlaceholderData: query.isPlaceholderData,
    error: query.error,
    refetch: query.refetch,
  }
}
