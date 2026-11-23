import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { TheoryMove } from '@/hooks/use-theory'
import { api } from '@/lib/api'

export type RepertoireNode = {
  fen: string
  move: TheoryMove | null
  game_count: number
  win_rate: number
  marked: boolean
  children: RepertoireNode[]
}

export type RepertoireTree = {
  username: string
  color: 'white' | 'black'
  root: RepertoireNode
}

export type RepertoireMarkInput = {
  username: string
  fen: string
  color: 'white' | 'black'
  intended_move_uci: string
  intended_move_san: string
  family_id?: number | null
  note?: string | null
}

export function useRepertoire(username: string | null, color: 'white' | 'black') {
  const query = useQuery({
    enabled: Boolean(username),
    queryKey: ['theory-repertoire', username, color],
    queryFn: async ({ signal }) => {
      const response = await api.get<RepertoireTree>('/api/theory/repertoire', {
        signal,
        params: { username, color },
      })
      return response.data
    },
    placeholderData: keepPreviousData,
    staleTime: 2 * 60 * 1000,
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

export function useRepertoireMark() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: RepertoireMarkInput & { remove?: boolean }) => {
      if (input.remove) {
        await api.delete('/api/theory/repertoire/mark', {
          params: { username: input.username, fen: input.fen, color: input.color },
        })
        return null
      }
      const response = await api.post('/api/theory/repertoire/mark', input)
      return response.data
    },
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['theory-repertoire', variables.username, variables.color],
      })
    },
  })
}
