/** Bounded crawler requests, including time spent reading the response body. */
export async function requestJson(url, { timeoutMs = 30_000, ...options } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('crawler request timed out')), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    if (!response.ok) {
      const body = await response.text()
      const error = new Error(`HTTP ${response.status}: ${body.slice(0, 2000)}`)
      error.status = response.status
      try { error.detail = JSON.parse(body).detail } catch { /* Not a structured API error. */ }
      // Only payload verdicts justify discarding computed work. Authentication,
      // timeouts, rate limiting and unavailable routes may recover unchanged.
      error.permanent = [400, 413, 422].includes(response.status)
      const retryAfter = response.headers.get('retry-after')
      if (retryAfter != null) {
        const seconds = Number(retryAfter)
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()
        if (Number.isFinite(delay)) error.retryAfterMs = Math.max(0, delay)
      }
      throw error
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}
