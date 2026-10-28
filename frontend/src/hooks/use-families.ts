import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'

export type FamilySummary = {
  id: number
  parent_id: number | null
  full_name: string
  display_name: string
  eco: string | null
  root_fen: string
  pgn: string
  depth: number
  is_main_line: boolean
  child_count: number
  user_game_count: number
  user_win_rate: number
}

export function useFamilies({
  username,
  color,
  timeClass,
  parentId = null,
  enabled = true,
}: {
  username: string | null
  color: 'white' | 'black' | 'both'
  timeClass: string | null
  parentId?: number | null
  enabled?: boolean
}) {
  const query = useQuery({
    queryKey: ['theory-families', username, color, timeClass, parentId],
    enabled,
    queryFn: async ({ signal }) => {
      const response = await api.get<FamilySummary[]>('/api/theory/families', {
        signal,
        params: {
          username: username ?? undefined,
          color,
          time_class: timeClass ?? undefined,
          parent_id: parentId ?? undefined,
        },
      })
      return response.data
    },
    placeholderData: keepPreviousData,
    staleTime: 10 * 60 * 1000,
  })

  const hasData = query.data != null

  return {
    data: query.data ?? [],
    isLoading: query.isLoading && !hasData,
    isRefreshing: query.isFetching && hasData,
    isPlaceholderData: query.isPlaceholderData,
    error: query.error,
  }
}
