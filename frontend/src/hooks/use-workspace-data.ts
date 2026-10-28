import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-errors'

export type WorkspaceGame = {
  id: number
  chesscom_game_url: string
  username: string
  white_username: string
  black_username: string
  white_rating: number | null
  black_rating: number | null
  user_color: string
  result: string
  user_result: string
  time_class: string
  eco: string | null
  opening_name: string | null
  played_at: string
  num_moves: number | null
  termination: string | null
  pgn: string | null
  has_analysis?: boolean
}

export type PaginatedGames = {
  games: WorkspaceGame[]
  total: number
  page: number
  per_page: number
}

export type OpeningGroup = {
  eco: string | null
  opening_name: string
  game_count: number
  wins: number
  losses: number
  draws: number
  latest_played_at: string
  representative_game_id: number
}

export type OpeningGroupsResponse = {
  openings: OpeningGroup[]
  total: number
  page: number
  per_page: number
}

export type OpeningPreview = {
  eco: string | null
  opening_name: string
  representative_game: WorkspaceGame
}

export type TrainingMove = {
  ply: number
  fen: string
  san: string
  uci: string
  resulting_fen: string
}

export type TrainingLine = {
  eco: string | null
  opening_name: string
  source_game_id: number
  moves: TrainingMove[]
}

type GamesFilters = {
  username: string | null
  color?: 'white' | 'black' | 'both'
  timeClass?: string | null
  openingName?: string | null
  eco?: string | null
  fen?: string | null
  page: number
  perPage?: number
  enabled?: boolean
}

export function usePaginatedGames({
  username,
  color = 'both',
  timeClass = null,
  openingName = null,
  eco = null,
  fen = null,
  page,
  perPage = 20,
  enabled = true,
}: GamesFilters) {
  const query = useQuery({
    enabled: enabled && Boolean(username),
    gcTime: 30 * 60 * 1000,
    queryKey: ['games', username, color, timeClass, openingName, eco, fen, page, perPage],
    queryFn: async ({ signal }) => {
      const response = await api.get<PaginatedGames>('/api/games', {
        signal,
        params: {
          username,
          color,
          time_class: timeClass ?? undefined,
          opening_name: openingName ?? undefined,
          eco: eco ?? undefined,
          fen: fen ?? undefined,
          page,
          per_page: perPage,
        },
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
    error: query.error ? getApiErrorMessage(query.error, 'Could not load games.') : null,
  }
}

export function useOpeningGroups(
  username: string | null,
  color: 'white' | 'black' | 'both',
  timeClass: string | null,
  page: number,
  perPage = 20,
  enabled = true,
) {
  const query = useQuery({
    enabled: enabled && Boolean(username),
    gcTime: 30 * 60 * 1000,
    queryKey: ['opening-groups', username, color, timeClass, page, perPage],
    queryFn: async ({ signal }) => {
      const response = await api.get<OpeningGroupsResponse>('/api/games/opening-groups', {
        signal,
        params: {
          username,
          color,
          time_class: timeClass ?? undefined,
          page,
          per_page: perPage,
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
    error: query.error ? getApiErrorMessage(query.error, 'Could not load opening groups.') : null,
  }
}

export function useOpeningPreview(
  username: string | null,
  openingName: string | null,
  eco: string | null,
  color: 'white' | 'black' | 'both',
  timeClass: string | null,
  enabled = true,
) {
  const query = useQuery({
    enabled: enabled && Boolean(username && openingName),
    queryKey: ['opening-preview', username, openingName, eco, color, timeClass],
    queryFn: async ({ signal }) => {
      const response = await api.get<OpeningPreview>('/api/games/opening-preview', {
        signal,
        params: {
          username,
          opening_name: openingName,
          eco: eco ?? undefined,
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
    error: query.error
      ? getApiErrorMessage(query.error, 'Could not load the opening preview.')
      : null,
  }
}

export function useTrainingLine(
  username: string | null,
  openingName: string | null,
  eco: string | null,
  color: 'white' | 'black' | 'both',
  timeClass: string | null,
  enabled = true,
) {
  const query = useQuery({
    enabled: enabled && Boolean(username && openingName),
    queryKey: ['training-line', username, openingName, eco, color, timeClass],
    queryFn: async ({ signal }) => {
      const response = await api.get<TrainingLine>('/api/theory/training-line', {
        signal,
        params: {
          username,
          opening_name: openingName,
          eco: eco ?? undefined,
          color,
          time_class: timeClass ?? undefined,
        },
      })
      return response.data
    },
    placeholderData: keepPreviousData,
    staleTime: 10 * 60 * 1000,
  })

  const hasData = query.data != null

  return {
    data: query.data ?? null,
    isLoading: query.isLoading && !hasData,
    isRefreshing: query.isFetching && hasData,
    isPlaceholderData: query.isPlaceholderData,
    error: query.error
      ? getApiErrorMessage(query.error, 'Could not load the training line.')
      : null,
  }
}

export async function fetchWorkspaceGame(gameId: number, signal?: AbortSignal) {
  const response = await api.get<WorkspaceGame>(`/api/games/${gameId}`, { signal })
  return response.data
}
