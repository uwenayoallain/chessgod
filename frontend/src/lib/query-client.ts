import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Internet reachability does not determine whether our local API works.
      networkMode: 'always',
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 2 * 60 * 1000,
    },
    mutations: {
      // Save learning progress immediately to the local backend while offline.
      networkMode: 'always',
    },
  },
})
