import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'

export type ImportSummary = {
  username: string
  total_games: number
  date_range: { from: string | null; to: string | null }
  games_by_time_class: Record<string, number>
  /** The player's rating in their newest game of each time control. */
  current_ratings?: Record<string, number>
}

export function useImportSummary(username: string | null, refreshKey: string | number = 0) {
  const query = useQuery({
    enabled: Boolean(username),
    queryKey: ['import-summary', username, refreshKey],
    queryFn: async ({ signal }) => {
      const response = await api.get<ImportSummary>(`/api/import/${username}/summary`, { signal })
      return response.data
    },
    retry: false,
    // The refresh key changes when an import starts, which swaps the query key
    // and would otherwise drop `data` to undefined mid-resync. That reads as
    // "this account has no games" and throws the user back to the import form
    // while their library is still there.
    placeholderData: keepPreviousData,
    staleTime: refreshKey === 0 ? 5 * 60 * 1000 : 0,
  })

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    isRefetching: query.isRefetching,
  }
}
