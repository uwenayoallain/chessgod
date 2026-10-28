import { describe, expect, it } from 'vite-plus/test'

import { getAppAccessState } from './app-access'

const base = { username: 'saint_uwe', isLoading: false, totalGames: 4212, unreachable: false }

describe('getAppAccessState', () => {
  it('asks for a username when there is none', () => {
    expect(getAppAccessState({ ...base, username: null }).state).toBe('missing_username')
  })

  it('waits while the summary is in flight', () => {
    expect(getAppAccessState({ ...base, isLoading: true, totalGames: null }).state).toBe('loading')
  })

  it('opens the workspace once games are known', () => {
    expect(getAppAccessState(base).state).toBe('ready')
  })

  it('offers the import form when the account really has no games', () => {
    expect(getAppAccessState({ ...base, totalGames: 0 }).state).toBe('empty')
  })

  it('says the server is unreachable rather than claiming the library is empty', () => {
    // The failure mode that matters: the API is down, so totalGames is unknown.
    // Reporting "empty" here shows an import form to someone with 4,000 games
    // and reads as data loss.
    expect(getAppAccessState({ ...base, totalGames: null, unreachable: true }).state).toBe(
      'unreachable',
    )
  })

  it('keeps a working workspace open when a background refresh fails', () => {
    expect(getAppAccessState({ ...base, unreachable: true }).state).toBe('ready')
  })

  it('still asks for a username even if the request failed', () => {
    expect(getAppAccessState({ ...base, username: null, unreachable: true }).state).toBe(
      'missing_username',
    )
  })

  it('treats a missing count with no outage as empty', () => {
    // A 404 from the summary endpoint lands here: no games under that name.
    expect(getAppAccessState({ ...base, totalGames: null }).state).toBe('empty')
  })
})
