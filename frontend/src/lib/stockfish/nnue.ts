export type NnueLoad = {
  index: number
  filename: string
}

async function verifyNnue(filename: string, buffer: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
  // Official NNUE filenames contain the first 12 hexadecimal SHA-256 digits.
  const expected = /^nn-([a-f0-9]{12})\.nnue$/.exec(filename)?.[1]
  if (!expected) throw new Error('Invalid analysis model filename.')
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
        return await verifyNnue(filename, await cached.arrayBuffer())
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
  if (cache) {
    try {
      await cache.put(url, new Response(bytes, { headers: response.headers }))
    } catch {
      // The verified bytes are usable even if the device cannot persist them.
    }
  }
  return bytes
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
