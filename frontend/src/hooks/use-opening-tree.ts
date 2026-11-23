import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-errors'

export type TreeMove = {
  san: string
  uci: string
  game_count: number
  white_wins: number
  draws: number
  black_wins: number
  resulting_fen: string
  is_book_move?: boolean
  master_game_count?: number | null
}

export type TreeNode = {
  fen: string
  total_games: number
  white_wins: number
  draws: number
  black_wins: number
  moves: TreeMove[]
}

export function useOpeningTree(
  fen: string,
  color: 'white' | 'black' | 'both',
  timeClass: string | null,
) {
  const query = useQuery({
    queryKey: ['opening-tree', fen, color, timeClass],
    queryFn: async ({ signal }) => {
      const response = await api.get<TreeNode>('/api/tree/position', {
        signal,
        params: { fen, color, time_class: timeClass ?? undefined },
      })
      return response.data
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60 * 1000,
  })

  const hasData = query.data != null

  return {
    data: query.data ?? null,
    isLoading: query.isLoading && !hasData,
    isRefreshing: query.isFetching && hasData,
    isPlaceholderData: query.isPlaceholderData,
    error: query.error
      ? new Error(getApiErrorMessage(query.error, 'Could not load the opening tree.'))
      : null,
  }
}
