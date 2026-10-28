export type AppAccessState = 'missing_username' | 'loading' | 'unreachable' | 'empty' | 'ready'

/**
 * Which screen the app owes the user.
 *
 * The important distinction is between "this account has no games" and "we
 * could not ask" — they look the same in the data (no count) and completely
 * different to a person. Showing the import form to someone with a full
 * library because the API was down reads as if their games were deleted.
 */
export function getAppAccessState({
  username,
  isLoading,
  totalGames,
  unreachable = false,
}: {
  username: string | null
  isLoading: boolean
  totalGames: number | null
  /** The server could not be reached — see `isServerUnreachable`. A 404 is
   *  not this: it means the account has no games here yet. */
  unreachable?: boolean
}) {
  if (!username) {
    return { state: 'missing_username' as AppAccessState }
  }
  if (isLoading) {
    return { state: 'loading' as AppAccessState }
  }
  // A known library wins over a failed refresh: a background error should never
  // evict someone from a workspace that is already working.
  if ((totalGames ?? 0) > 0) {
    return { state: 'ready' as AppAccessState }
  }
  if (unreachable) {
    return { state: 'unreachable' as AppAccessState }
  }
  return { state: 'empty' as AppAccessState }
}
