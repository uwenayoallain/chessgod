import { describe, expect, it } from 'vite-plus/test'

import { describeImportError } from './import-errors'

const CHESSCOM_404 =
  "Client error '404 Not Found' for url 'https://api.chess.com/pub/player/zzz-nope/games/archives' " +
  'For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404'

describe('describeImportError', () => {
  it('explains the commonest failure: a mistyped username', () => {
    expect(describeImportError(CHESSCOM_404, 'zzz-nope')).toBe(
      'Chess.com has no account called “zzz-nope”. Check the spelling — this is your Chess.com username, not your email address.',
    )
  })

  it('does not echo an empty name back at the user', () => {
    expect(describeImportError(CHESSCOM_404, '   ')).toBe(
      'Chess.com has no account with that name. Check the spelling.',
    )
  })

  it('says to wait when Chess.com is rate-limiting', () => {
    expect(describeImportError("Client error '429 Too Many Requests'", 'saint_uwe')).toMatch(
      /Wait a minute/,
    )
  })

  it('separates a Chess.com outage from a bad username', () => {
    expect(
      describeImportError("Server error '503' for url 'https://api.chess.com/pub/x'", 'saint_uwe'),
    ).toMatch(/not responding/)
  })

  it('passes an unrecognised message through rather than hiding it', () => {
    expect(describeImportError('Database connection lost', 'saint_uwe')).toBe(
      'Database connection lost',
    )
  })

  it('does not mistake a 404 from somewhere else for a bad username', () => {
    const other = "Client error '404 Not Found' for url 'https://example.com/thing'"
    expect(describeImportError(other, 'saint_uwe')).toBe(other)
  })

  it('survives an empty message', () => {
    expect(describeImportError('', 'saint_uwe')).toBe('')
  })
})
