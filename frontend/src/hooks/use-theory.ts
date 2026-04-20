import { useEffect, useState } from 'react'

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
}

export function useTheory(fen: string) {
  const [data, setData] = useState<TheoryComparison | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setIsLoading(true)
      setError(null)
      try {
        const response = await api.get<TheoryComparison>('/api/theory/compare', { params: { fen } })
        if (!cancelled) {
          setData(response.data)
        }
      } catch (caught) {
        if (!cancelled) {
          setError(new Error(getApiErrorMessage(caught, 'Could not load theory data.')))
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [fen])

  return { data, isLoading, error }
}

export function useTheoryDeviations(color: 'white' | 'black', minGames = 2) {
  const [data, setData] = useState<TheoryDeviation[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setIsLoading(true)
      setError(null)
      try {
        const response = await api.get<TheoryDeviation[]>('/api/theory/deviations', {
          params: { color, min_games: minGames },
        })
        if (!cancelled) {
          setData(response.data)
        }
      } catch (caught) {
        if (!cancelled) {
          setError(new Error(getApiErrorMessage(caught, 'Could not load theory deviations.')))
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [color, minGames])

  return { data, isLoading, error }
}
