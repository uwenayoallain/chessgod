import { useEffect, useState } from 'react'

import { api } from '@/lib/api'

export type ColorStats = {
  wins: number
  losses: number
  draws: number
}

export type OpeningStat = {
  opening_name: string
  games: number
}

export type TimeClassStats = {
  games: number
  wins: number
  losses: number
  draws: number
  win_rate: number
}

export type GameStats = {
  total_games: number
  win_rate: number
  by_color: { white: ColorStats; black: ColorStats }
  by_time_class: Record<string, TimeClassStats>
  by_opening: OpeningStat[]
}

const statsCache = new Map<string, GameStats | null>()

export function useGameStats(username: string | null, refreshKey: string | number = 0) {
  const hasCachedStats = Boolean(username && statsCache.has(username))
  const [data, setData] = useState<GameStats | null>(username ? statsCache.get(username) ?? null : null)
  const [isLoading, setIsLoading] = useState(Boolean(username && !hasCachedStats))

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!username) {
        setData(null)
        setIsLoading(false)
        return
      }

      if (statsCache.has(username) && refreshKey === 0) {
        setData(statsCache.get(username) ?? null)
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      try {
        const response = await api.get<GameStats>('/api/games/stats', { params: { username } })
        if (!cancelled) {
          statsCache.set(username, response.data)
          setData(response.data)
        }
      } catch {
        if (!cancelled) {
          if (!statsCache.has(username)) {
            statsCache.set(username, null)
            setData(null)
          }
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
  }, [username, refreshKey])

  return { data, isLoading }
}
