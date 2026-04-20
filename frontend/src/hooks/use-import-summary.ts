import { useEffect, useState } from 'react'

import { api } from '@/lib/api'

export type ImportSummary = {
  username: string
  total_games: number
  date_range: { from: string | null; to: string | null }
  games_by_time_class: Record<string, number>
}

const summaryCache = new Map<string, ImportSummary | null>()

export function useImportSummary(username: string | null, refreshKey: string | number = 0) {
  const hasCachedSummary = Boolean(username && summaryCache.has(username))
  const [data, setData] = useState<ImportSummary | null>(username ? summaryCache.get(username) ?? null : null)
  const [isLoading, setIsLoading] = useState(Boolean(username && !hasCachedSummary))

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!username) {
        setData(null)
        setIsLoading(false)
        return
      }

      if (summaryCache.has(username) && refreshKey === 0) {
        setData(summaryCache.get(username) ?? null)
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      try {
        const response = await api.get<ImportSummary>(`/api/import/${username}/summary`)
        if (!cancelled) {
          summaryCache.set(username, response.data)
          setData(response.data)
        }
      } catch {
        if (!cancelled) {
          if (!summaryCache.has(username)) {
            summaryCache.set(username, null)
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
