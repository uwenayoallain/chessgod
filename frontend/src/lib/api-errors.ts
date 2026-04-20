import axios from 'axios'

export function getApiErrorMessage(caught: unknown, fallback: string) {
  if (axios.isAxiosError(caught)) {
    const detail = caught.response?.data?.detail
    if (typeof detail === 'string' && detail.trim()) {
      return detail
    }

    if (caught.code === 'ERR_NETWORK') {
      return 'Backend unavailable. Check that the API container is running and reachable.'
    }

    if (typeof caught.message === 'string' && caught.message.trim()) {
      return caught.message
    }
  }

  if (caught instanceof Error && caught.message.trim()) {
    return caught.message
  }

  return fallback
}
