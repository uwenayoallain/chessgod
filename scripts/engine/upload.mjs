import { requestJson } from './http.mjs'

/** Flush completed searches once even during shutdown; retry only while running. */
export async function uploadWithRetry(items, {
  upload, stopping, sleep, busyMs, maxRetryMs, log = () => {},
}) {
  for (let attempt = 1; attempt === 1 || !stopping(); attempt += 1) {
    try {
      return await upload(items)
    } catch (error) {
      if (error.permanent) {
        log(`upload rejected, discarding ${items.length} evaluations: ${error.message}`)
        return { stored: 0, skipped: 0, upgraded: 0 }
      }
      if (stopping()) {
        log(`final upload failed for ${items.length} evaluations: ${error.message}; positions remain queued`)
        return null
      }
      const wait = Math.max(Math.min(busyMs * attempt, maxRetryMs), error.retryAfterMs ?? 0)
      log(`upload failed (attempt ${attempt}): ${error.message}; retrying in ${Math.round(wait / 1000)}s`)
      await sleep(wait)
    }
  }
  return null
}

function rejectedIndices(error, length) {
  if (error.status !== 422 || !Array.isArray(error.detail) || error.detail.length === 0) return null
  const indices = new Set()
  for (const issue of error.detail) {
    const loc = issue?.loc
    if (!Array.isArray(loc) || loc[0] !== 'body' || loc[1] !== 'items'
      || !Number.isInteger(loc[2]) || loc[2] < 0 || loc[2] >= length) return null
    indices.add(loc[2])
  }
  return indices
}

/** Preserve good work when validation precisely identifies bad batch items. */
export async function uploadEvaluations(api, items, { request = requestJson, onRejected = () => {} } = {}) {
  const total = { stored: 0, skipped: 0, upgraded: 0, rejected: 0 }
  for (let start = 0; start < items.length; start += 100) {
    let pending = items.slice(start, start + 100)
    while (pending.length) {
      try {
        const result = await request(new URL('/api/analysis/evaluations', api), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: pending }),
        })
        for (const key of ['stored', 'skipped', 'upgraded']) total[key] += result[key] ?? 0
        break
      } catch (error) {
        const rejected = rejectedIndices(error, pending.length)
        if (rejected === null) throw error
        const invalid = pending.filter((_, index) => rejected.has(index))
        total.rejected += invalid.length
        onRejected(invalid, error.detail)
        // Each validation retry shrinks the payload, so this loop is bounded
        // by the chunk size. Do not mutate the original batch used by retries.
        pending = pending.filter((_, index) => !rejected.has(index))
      }
    }
  }
  return total
}
