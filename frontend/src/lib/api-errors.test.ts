import { AxiosError, AxiosHeaders } from 'axios'
import { describe, expect, it } from 'vite-plus/test'

import { getApiErrorMessage, isServerUnreachable } from './api-errors'

function axiosError(status?: number, detail?: string) {
  const error = new AxiosError('Request failed')
  if (status != null) {
    error.response = {
      status,
      statusText: '',
      data: detail ? { detail } : {},
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
    }
  }
  return error
}

describe('isServerUnreachable', () => {
  it('is false when nothing went wrong', () => {
    expect(isServerUnreachable(null)).toBe(false)
    expect(isServerUnreachable(undefined)).toBe(false)
  })

  it('treats a missing response as unreachable', () => {
    // Connection refused, DNS failure, CORS — the request never landed.
    expect(isServerUnreachable(axiosError())).toBe(true)
  })

  it('treats a server fault as unreachable', () => {
    expect(isServerUnreachable(axiosError(500))).toBe(true)
    expect(isServerUnreachable(axiosError(502))).toBe(true)
  })

  it('does not treat "no such record" as an outage', () => {
    // The screen this drives says "your games are still stored"; showing it
    // for a mistyped username would be a lie.
    expect(isServerUnreachable(axiosError(404))).toBe(false)
  })

  it('does not treat other client errors as an outage', () => {
    expect(isServerUnreachable(axiosError(400))).toBe(false)
    expect(isServerUnreachable(axiosError(422))).toBe(false)
  })

  it('does not claim an outage for a plain error', () => {
    expect(isServerUnreachable(new Error('boom'))).toBe(false)
  })
})

describe('getApiErrorMessage', () => {
  it('prefers the server-supplied detail', () => {
    expect(getApiErrorMessage(axiosError(404, 'No import summary available'), 'fallback')).toBe(
      'No import summary available',
    )
  })

  it('falls back when there is nothing useful', () => {
    expect(getApiErrorMessage({}, 'Import failed')).toBe('Import failed')
  })

  it('translates a server fault into a sentence', () => {
    // Not "Request failed with status code 500".
    expect(getApiErrorMessage(axiosError(500), 'fallback')).toBe(
      'The server hit an error. Try again in a moment.',
    )
  })

  it('says plainly when the server could not be reached', () => {
    expect(getApiErrorMessage(axiosError(), 'fallback')).toBe(
      'Can’t reach the server. Check your connection and try again.',
    )
  })

  it('has wording for rate limiting and for nothing found', () => {
    expect(getApiErrorMessage(axiosError(429), 'fallback')).toMatch(/Wait a moment/)
    expect(getApiErrorMessage(axiosError(404), 'fallback')).toBe('Nothing found for that request.')
  })

  it('still prefers a detail the server took the trouble to send', () => {
    expect(getApiErrorMessage(axiosError(500, 'Opening tree rebuild failed'), 'fallback')).toBe(
      'Opening tree rebuild failed',
    )
  })
})
