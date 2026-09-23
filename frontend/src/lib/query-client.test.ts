import { onlineManager } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vite-plus/test'

import { queryClient } from './query-client'

afterEach(() => {
  queryClient.clear()
  onlineManager.setOnline(true)
})

it('loads existing local data when the browser reports no internet', async () => {
  onlineManager.setOnline(false)
  const loadGames = vi.fn().mockResolvedValue([{ id: 1 }])
  const games = await queryClient.fetchQuery({ queryKey: ['offline-games'], queryFn: loadGames })
  expect(games).toEqual([{ id: 1 }])
  expect(loadGames).toHaveBeenCalledOnce()
})

it('records local learning progress without waiting for internet', async () => {
  onlineManager.setOnline(false)
  const saveProgress = vi.fn().mockResolvedValue({ attempts: 2 })
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationKey: ['offline-attempt'],
    mutationFn: saveProgress,
  })
  expect(await mutation.execute({ played_move_uci: 'e2e4' })).toEqual({ attempts: 2 })
  expect(saveProgress).toHaveBeenCalledOnce()
  expect(mutation.state.isPaused).toBe(false)
})
