import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import type { StudyGuideResponse } from '@/lib/training/study-types'

export function studyGuideQueryKey(username: string | null, timeClass: string | null) {
  return ['study-guide', username, timeClass ?? 'rapid_blitz'] as const
}

export function useStudyGuide({
  username,
  timeClass,
  enabled = true,
}: {
  username: string | null
  timeClass: string | null
  enabled?: boolean
}) {
  return useQuery({
    enabled: Boolean(username) && enabled,
    queryKey: studyGuideQueryKey(username, timeClass),
    queryFn: async ({ signal }) => {
      const normalized = timeClass === 'rapid' || timeClass === 'blitz' ? timeClass : 'rapid_blitz'
      const { data } = await api.get<StudyGuideResponse>('/api/study/guide', {
        params: { username, time_class: normalized },
        signal,
      })
      return data
    },
    staleTime: 5 * 60 * 1000,
  })
}
