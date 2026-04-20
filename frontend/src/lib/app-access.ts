export type AppAccessState = 'missing_username' | 'loading' | 'empty' | 'ready'

export function getAppAccessState({
  username,
  isLoading,
  totalGames,
}: {
  username: string | null
  isLoading: boolean
  totalGames: number | null
}) {
  if (!username) {
    return { state: 'missing_username' as AppAccessState }
  }
  if (isLoading) {
    return { state: 'loading' as AppAccessState }
  }
  if ((totalGames ?? 0) <= 0) {
    return { state: 'empty' as AppAccessState }
  }
  return { state: 'ready' as AppAccessState }
}
