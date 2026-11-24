import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'

import { api } from '@/lib/api'
import type {
  StudyCourseDeleteResponse,
  StudyCourseDetail,
  StudyCourseImportRequest,
  StudyCourseReviewRequest,
  StudyCourseReviewResponse,
  StudyCoursesListResponse,
  StudyGuideResponse,
} from '@/lib/training/study-types'

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

export function studyCoursesQueryKey(username: string | null) {
  return ['study-courses', username] as const
}

export function studyCourseQueryKey(username: string | null, courseId: number | null) {
  return ['study-course', username, courseId] as const
}

/** Drops every cached course list and course for the player, so progress reads fresh. */
export function invalidateStudyCourses(queryClient: QueryClient, username: string | null) {
  void queryClient.invalidateQueries({
    predicate: (query) =>
      (query.queryKey[0] === 'study-courses' || query.queryKey[0] === 'study-course') &&
      query.queryKey[1] === username,
  })
}

export function useStudyCourses(username: string | null) {
  return useQuery({
    enabled: Boolean(username),
    queryKey: studyCoursesQueryKey(username),
    queryFn: async ({ signal }) => {
      const { data } = await api.get<StudyCoursesListResponse>('/api/study/courses', {
        params: { username },
        signal,
      })
      return data
    },
    staleTime: 60 * 1000,
  })
}

export function useStudyCourse(username: string | null, courseId: number | null) {
  return useQuery({
    enabled: Boolean(username) && courseId != null,
    queryKey: studyCourseQueryKey(username, courseId),
    queryFn: async ({ signal }) => {
      const { data } = await api.get<StudyCourseDetail>(`/api/study/courses/${courseId}`, {
        params: { username },
        signal,
      })
      return data
    },
    staleTime: 60 * 1000,
  })
}

export function useImportStudyCourse(username: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body: Omit<StudyCourseImportRequest, 'username'>) => {
      const { data } = await api.post<StudyCourseDetail>('/api/study/courses/import', {
        ...body,
        username,
      })
      return data
    },
    onSuccess: (course) => {
      queryClient.setQueryData(studyCourseQueryKey(username, course.id), course)
      invalidateStudyCourses(queryClient, username)
    },
  })
}

export function useDeleteStudyCourse(username: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (courseId: number) => {
      const { data } = await api.delete<StudyCourseDeleteResponse>(
        `/api/study/courses/${courseId}`,
        { params: { username } },
      )
      return data
    },
    onSuccess: (result) => {
      queryClient.removeQueries({ queryKey: studyCourseQueryKey(username, result.id) })
      invalidateStudyCourses(queryClient, username)
    },
  })
}

export async function submitStudyCourseReview(
  courseId: number,
  body: StudyCourseReviewRequest,
): Promise<StudyCourseReviewResponse> {
  const { data } = await api.post<StudyCourseReviewResponse>(
    `/api/study/courses/${courseId}/review`,
    body,
  )
  return data
}
