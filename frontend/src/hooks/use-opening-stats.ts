import { useEffect, useState } from 'react'

import { api } from '@/lib/api'

export type OpeningDetailStat = {
  eco: string | null
  opening_name: string
  game_count: number
  wins: number
  losses: number
  draws: number
  win_rate: number
  avg_rating: number | null
}

const cache = new Map<string, OpeningDetailStat[]>()

export function useOpeningStats(
  username: string | null,
  color: 'white' | 'black' | 'both',
  timeClass: string | null,
) {
  const [data, setData] = useState<OpeningDetailStat[]>([])
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!username) {
        setData([])
        return
      }

      const key = `${username}:${color}:${timeClass ?? 'all'}`
      if (cache.has(key)) {
        setData(cache.get(key) ?? [])
        return
      }

      setIsLoading(true)
      try {
        const response = await api.get<OpeningDetailStat[]>('/api/games/openings', {
          params: { username, color, time_class: timeClass ?? undefined },
        })
        if (!cancelled) {
          cache.set(key, response.data)
          setData(response.data)
        }
      } catch {
        if (!cancelled) {
          setData([])
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
  }, [username, color, timeClass])

  return { data, isLoading }
}
