import { useEffect, useState } from 'react'

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
  pgn: string | null
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

const gamesCache = new Map<string, PaginatedGames>()
const openingsCache = new Map<string, OpeningGroupsResponse>()
const previewCache = new Map<string, OpeningPreview>()
const trainingCache = new Map<string, TrainingLine>()

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
  const [data, setData] = useState<PaginatedGames | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!enabled || !username) {
        setData(null)
        setError(null)
        return
      }

      const key = JSON.stringify({ username, color, timeClass, openingName, eco, fen, page, perPage })
      if (gamesCache.has(key)) {
        setData(gamesCache.get(key) ?? null)
        setError(null)
        return
      }

      setIsLoading(true)
      setError(null)
      try {
        const response = await api.get<PaginatedGames>('/api/games', {
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
        if (!cancelled) {
          gamesCache.set(key, response.data)
          setData(response.data)
        }
      } catch (caught) {
        if (!cancelled) {
          setError(getApiErrorMessage(caught, 'Could not load games.'))
          setData(null)
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [color, eco, enabled, fen, openingName, page, perPage, timeClass, username])

  return { data, isLoading, error }
}

export function useOpeningGroups(
  username: string | null,
  color: 'white' | 'black' | 'both',
  timeClass: string | null,
  page: number,
  perPage = 20,
  enabled = true,
) {
  const [data, setData] = useState<OpeningGroupsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!enabled || !username) {
        setData(null)
        setError(null)
        return
      }

      const key = JSON.stringify({ username, color, timeClass, page, perPage })
      if (openingsCache.has(key)) {
        setData(openingsCache.get(key) ?? null)
        setError(null)
        return
      }

      setIsLoading(true)
      setError(null)
      try {
        const response = await api.get<OpeningGroupsResponse>('/api/games/opening-groups', {
          params: {
            username,
            color,
            time_class: timeClass ?? undefined,
            page,
            per_page: perPage,
          },
        })
        if (!cancelled) {
          openingsCache.set(key, response.data)
          setData(response.data)
        }
      } catch (caught) {
        if (!cancelled) {
          setError(getApiErrorMessage(caught, 'Could not load opening groups.'))
          setData(null)
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [color, enabled, page, perPage, timeClass, username])

  return { data, isLoading, error }
}

export function useOpeningPreview(
  username: string | null,
  openingName: string | null,
  eco: string | null,
  color: 'white' | 'black' | 'both',
  timeClass: string | null,
  enabled = true,
) {
  const [data, setData] = useState<OpeningPreview | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!enabled || !username || !openingName) {
        setData(null)
        setError(null)
        return
      }

      const key = JSON.stringify({ username, openingName, eco, color, timeClass })
      if (previewCache.has(key)) {
        setData(previewCache.get(key) ?? null)
        setError(null)
        return
      }

      setIsLoading(true)
      setError(null)
      try {
        const response = await api.get<OpeningPreview>('/api/games/opening-preview', {
          params: {
            username,
            opening_name: openingName,
            eco: eco ?? undefined,
            color,
            time_class: timeClass ?? undefined,
          },
        })
        if (!cancelled) {
          previewCache.set(key, response.data)
          setData(response.data)
        }
      } catch (caught) {
        if (!cancelled) {
          setError(getApiErrorMessage(caught, 'Could not load the opening preview.'))
          setData(null)
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [color, eco, enabled, openingName, timeClass, username])

  return { data, isLoading, error }
}

export function useTrainingLine(
  username: string | null,
  openingName: string | null,
  eco: string | null,
  color: 'white' | 'black' | 'both',
  timeClass: string | null,
  enabled = true,
) {
  const [data, setData] = useState<TrainingLine | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!enabled || !username || !openingName) {
        setData(null)
        setError(null)
        return
      }

      const key = JSON.stringify({ username, openingName, eco, color, timeClass })
      if (trainingCache.has(key)) {
        setData(trainingCache.get(key) ?? null)
        setError(null)
        return
      }

      setIsLoading(true)
      setError(null)
      try {
        const response = await api.get<TrainingLine>('/api/theory/training-line', {
          params: {
            username,
            opening_name: openingName,
            eco: eco ?? undefined,
            color,
            time_class: timeClass ?? undefined,
          },
        })
        if (!cancelled) {
          trainingCache.set(key, response.data)
          setData(response.data)
        }
      } catch (caught) {
        if (!cancelled) {
          setError(getApiErrorMessage(caught, 'Could not load the training line.'))
          setData(null)
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [color, eco, enabled, openingName, timeClass, username])

  return { data, isLoading, error }
}
