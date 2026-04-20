import { useEffect, useState } from 'react'

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

const cache = new Map<string, TreeNode>()

export function useOpeningTree(
  fen: string,
  color: 'white' | 'black' | 'both',
  timeClass: string | null,
) {
  const [data, setData] = useState<TreeNode | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    const key = `${fen}:${color}:${timeClass ?? 'all'}`
    if (cache.has(key)) {
      setData(cache.get(key) ?? null)
      return
    }

    const timeout = window.setTimeout(async () => {
      setIsLoading(true)
      setError(null)
      try {
        const response = await api.get<TreeNode>('/api/tree/position', {
          params: { fen, color, time_class: timeClass ?? undefined },
        })
        cache.set(key, response.data)
        setData(response.data)
      } catch (caught) {
        setError(new Error(getApiErrorMessage(caught, 'Could not load the opening tree.')))
      } finally {
        setIsLoading(false)
      }
    }, 100)

    return () => window.clearTimeout(timeout)
  }, [fen, color, timeClass])

  return { data, isLoading, error }
}
