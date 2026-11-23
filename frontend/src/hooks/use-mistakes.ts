import { keepPreviousData, useQuery } from '@tanstack/react-query'

import type { Mistake } from '@/hooks/use-family-detail'
import { api } from '@/lib/api'

export function useMistakes({
  username,
  color,
  timeClass = 'rapid_blitz',
  familyId = null,
  enabled = true,
}: {
  username: string | null
  color: 'white' | 'black' | 'both'
  timeClass?: string | null
  familyId?: number | null
  enabled?: boolean
}) {
  const query = useQuery({
    enabled: enabled && Boolean(username),
    queryKey: ['theory-mistakes', username, color, timeClass, familyId],
    queryFn: async ({ signal }) => {
      const response = await api.get<Mistake[]>('/api/theory/mistakes', {
        signal,
        params: {
          username,
          color,
          time_class: timeClass ?? undefined,
          family_id: familyId ?? undefined,
          min_occurrences: 1,
          threshold_cp: 50,
        },
      })
      return response.data
    },
    placeholderData: keepPreviousData,
    staleTime: 2 * 60 * 1000,
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
