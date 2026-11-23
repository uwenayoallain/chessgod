export type NnueLoad = {
  index: number
  filename: string
}

// Written onto a cached copy only after its bytes were hashed and matched, so
// a later read can trust them without hashing ~98MB again (177-263ms of CPU
// per engine start, measured; the review pool starts four at once and the
// main engine restarts after its idle release). A copy that was truncated or
// replaced fails the length or name check and is hashed in full as before.
const VERIFIED_HEADER = 'x-chessgod-verified'

function expectedDigest(filename: string): string {
  // Official NNUE filenames contain the first 12 hexadecimal SHA-256 digits.
  const expected = /^nn-([a-f0-9]{12})\.nnue$/.exec(filename)?.[1]
  if (!expected) throw new Error('Invalid analysis model filename.')
  return expected
}

export function verifiedMarker(filename: string, byteLength: number): string {
  return `${expectedDigest(filename)}:${byteLength}`
}

async function verifyNnue(filename: string, buffer: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
  const expected = expectedDigest(filename)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))
  const actual = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  if (!actual.startsWith(expected)) throw new Error('Analysis model integrity check failed.')
  return new Uint8Array(buffer)
}

/** Cache storage is optional; only verified model bytes may reach the engine. */
export async function fetchNnueBuffer(
  url: string,
  filename: string,
): Promise<Uint8Array<ArrayBuffer>> {
  let cache: Cache | undefined
  let replaceCorruptCache = false
  try {
    cache = await caches.open('chessgod-stockfish-19-v1')
    const cached = await cache.match(url)
    if (cached) {
      try {
        if (!cached.ok) throw new Error('Invalid cached model response.')
        const marker = cached.headers.get(VERIFIED_HEADER)
        const buffer = await cached.arrayBuffer()
        if (marker && marker === verifiedMarker(filename, buffer.byteLength)) {
          return new Uint8Array(buffer)
        }
        const bytes = await verifyNnue(filename, buffer)
        // A copy cached before the marker existed: mark it, once.
        await putVerified(cache, url, bytes, cached.headers, filename)
        return bytes
      } catch {
        replaceCorruptCache = true
        await cache.delete(url).catch(() => false)
      }
    }
  } catch {
    // Disabled storage or quota/access failures must not block analysis.
    cache = undefined
  }

  const response = await fetch(url, replaceCorruptCache ? { cache: 'reload' } : undefined)
  if (!response.ok) throw new Error(`Failed to load NNUE ${filename}: ${response.status}`)
  const bytes = await verifyNnue(filename, await response.arrayBuffer())
  if (cache) await putVerified(cache, url, bytes, response.headers, filename)
  return bytes
}

async function putVerified(
  cache: Cache,
  url: string,
  bytes: Uint8Array<ArrayBuffer>,
  source: Headers,
  filename: string,
) {
  try {
    const headers = new Headers(source)
    headers.set(VERIFIED_HEADER, verifiedMarker(filename, bytes.byteLength))
    await cache.put(url, new Response(bytes, { headers }))
  } catch {
    // The verified bytes are usable even if the device cannot persist them.
  }
}

/**
 * Decides which NNUE files to load, and at which index.
 *
 * Stockfish 19 is a single-net build. Older dual-net builds reported a big net
 * at index 0 and a small net at index 1 and needed both, so the loader remains
 * backwards-compatible instead of assuming one engine generation.
 *
 * Single-net builds are documented to "ignore" the
 * index argument, which in practice means returning '' or echoing index 0's
 * name; a throw is not ruled out either. All three degrade to a single load.
 */
export function resolveNnueLoads(
  getRecommendedName: (index: number) => string | undefined,
): NnueLoad[] {
  const nameAt = (index: number): string => {
    try {
      return getRecommendedName(index) || ''
    } catch {
      return ''
    }
  }

  const big = nameAt(0)
  if (!big) return []

  const loads: NnueLoad[] = [{ index: 0, filename: big }]

  const small = nameAt(1)
  if (small && small !== big) {
    loads.push({ index: 1, filename: small })
  }

  return loads
}
