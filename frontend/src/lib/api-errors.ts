import axios from 'axios'

export function getApiErrorMessage(caught: unknown, fallback: string) {
  if (axios.isAxiosError(caught)) {
    const detail = caught.response?.data?.detail
    if (typeof detail === 'string' && detail.trim()) {
      return detail
    }

    const status = caught.response?.status
    if (status == null) {
      return 'Could not reach the server.'
    }

    // Axios' own wording ("Request failed with status code 500") is not a
    // sentence anyone can act on, so it is only the last resort.
    if (status >= 500) return 'The server had a problem handling that request.'
    if (status === 404) return 'The server had nothing for that request.'
    if (status === 429) return 'Too many requests just now. Wait a moment, then try again.'
    if (status === 401 || status === 403) return 'Not allowed to read that.'

    if (typeof caught.message === 'string' && caught.message.trim()) {
      return caught.message
    }
  }

  if (caught instanceof Error && caught.message.trim()) {
    return caught.message
  }

  return fallback
}

/**
 * Whether a failure means the server could not be reached, as opposed to the
 * server answering that it has nothing for us.
 *
 * The distinction decides which screen a user sees, so it has to be exact: a
 * 404 from the summary endpoint means "no games under that name yet", and
 * reporting it as an outage tells someone their library is missing when they
 * have simply mistyped a username.
 */
export function isServerUnreachable(caught: unknown): boolean {
  if (!caught) return false

  if (axios.isAxiosError(caught)) {
    const status = caught.response?.status
    // No response at all: network failure, DNS, CORS, connection refused.
    if (status == null) return true
    // The server answered. Only its own faults count as unreachable.
    return status >= 500
  }

  return false
}
