import { keepPreviousData, useQuery } from '@tanstack/react-query'

import type { TreeNode } from '@/hooks/use-opening-tree'
import type { FamilySummary } from '@/hooks/use-families'
import type { TheoryMove } from '@/hooks/use-theory'
import { api } from '@/lib/api'

export type Mistake = {
  parent_fen: string
  ply: number
  user_move: TheoryMove
  best_move: TheoryMove
  eval_drop_cp: number
  severity: string
  occurrences: number
  family_id: number | null
  family_name: string | null
}

export type FamilyDetail = {
  family: FamilySummary
  ancestors: FamilySummary[]
  children: FamilySummary[]
  position_tree: TreeNode
  top_mistakes: Mistake[]
}

export function useFamilyDetail({
  familyId,
  username,
  color,
  timeClass,
}: {
  familyId: number | null
  username: string | null
  color: 'white' | 'black' | 'both'
  timeClass: string | null
}) {
  const query = useQuery({
    enabled: familyId != null,
    queryKey: ['theory-family-detail', familyId, username, color, timeClass],
    queryFn: async ({ signal }) => {
      const response = await api.get<FamilyDetail>(`/api/theory/families/${familyId}`, {
        signal,
        params: {
          username: username ?? undefined,
          color,
          time_class: timeClass ?? undefined,
        },
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
    error: query.error,
  }
}
