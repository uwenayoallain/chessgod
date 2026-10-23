import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { fetchNnueBuffer, resolveNnueLoads, verifiedMarker } from './nnue'

const BIG = 'nn-1a298aa575a0.nnue'
const SMALL = 'nn-37f18f62d772.nnue'

afterEach(() => vi.unstubAllGlobals())

describe('verified NNUE loading', () => {
  const filename = 'nn-039058c6f2c0.nnue'
  const url = `http://localhost/stockfish/${filename}`
  const valid = () => new Response(new Uint8Array([1, 2, 3]))

  it('uses a verified cached model without downloading it', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue({ match: async () => valid() }) })
    expect(await fetchNnueBuffer(url, filename)).toEqual(new Uint8Array([1, 2, 3]))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('trusts a copy it marked as verified, without hashing it again', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest')
    const marked = () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'x-chessgod-verified': verifiedMarker(filename, 3) },
      })
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue({ match: async () => marked() }) })
    expect(await fetchNnueBuffer(url, filename)).toEqual(new Uint8Array([1, 2, 3]))
    expect(digest).not.toHaveBeenCalled()
    digest.mockRestore()
  })

  it('hashes a marked copy whose length no longer matches, and replaces it if it is bad', async () => {
    const truncated = () =>
      new Response(new Uint8Array([1, 2]), {
        headers: { 'x-chessgod-verified': verifiedMarker(filename, 3) },
      })
    const cache = {
      match: async () => truncated(),
      delete: vi.fn().mockResolvedValue(true),
      put: vi.fn().mockResolvedValue(undefined),
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => valid()),
    )
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) })
    expect(await fetchNnueBuffer(url, filename)).toEqual(new Uint8Array([1, 2, 3]))
    expect(cache.delete).toHaveBeenCalledWith(url)
  })

  it('marks a copy cached before the marker existed, once it has been hashed', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue({ match: async () => valid(), put }),
    })
    expect(await fetchNnueBuffer(url, filename)).toEqual(new Uint8Array([1, 2, 3]))
    const stored = put.mock.calls[0]?.[1] as Response
    expect(stored.headers.get('x-chessgod-verified')).toBe(verifiedMarker(filename, 3))
  })

  it('replaces a corrupted cache entry with verified bytes', async () => {
    const cache = {
      match: async () => new Response(new Uint8Array([9])),
      delete: vi.fn().mockResolvedValue(true),
      put: vi.fn().mockResolvedValue(undefined),
    }
    const fetch = vi.fn(async () => valid())
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) })
    expect(await fetchNnueBuffer(url, filename)).toEqual(new Uint8Array([1, 2, 3]))
    expect(cache.delete).toHaveBeenCalledWith(url)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, { cache: 'reload' })
    expect(cache.put).toHaveBeenCalledTimes(1)
  })

  it('does not redownload a valid model when the cache is full', async () => {
    const fetch = vi.fn(async () => valid())
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue({
        match: async () => undefined,
        put: async () => {
          throw new Error('Quota exceeded')
        },
      }),
    })
    expect(await fetchNnueBuffer(url, filename)).toEqual(new Uint8Array([1, 2, 3]))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects corrupted downloads instead of persisting or evaluating them', async () => {
    const put = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([9]))),
    )
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue({ match: async () => undefined, put }),
    })
    await expect(fetchNnueBuffer(url, filename)).rejects.toThrow('integrity check failed')
    expect(put).not.toHaveBeenCalled()
  })

  it('loads verified bytes when browser cache storage is unavailable', async () => {
    vi.stubGlobal('caches', undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => valid()),
    )
    expect(await fetchNnueBuffer(url, filename)).toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('resolveNnueLoads', () => {
  it('still loads both nets for older dual-net builds', () => {
    const loads = resolveNnueLoads((index) => (index === 0 ? BIG : SMALL))

    expect(loads).toEqual([
      { index: 0, filename: BIG },
      { index: 1, filename: SMALL },
    ])
  })

  it('loads one net when a single-net build returns an empty name for index 1', () => {
    const loads = resolveNnueLoads((index) => (index === 0 ? BIG : ''))

    expect(loads).toEqual([{ index: 0, filename: BIG }])
  })

  it('loads one net when a single-net build echoes index 0 for index 1', () => {
    const loads = resolveNnueLoads(() => BIG)

    expect(loads).toEqual([{ index: 0, filename: BIG }])
  })

  it('loads one net when a single-net build throws for index 1', () => {
    const loads = resolveNnueLoads((index) => {
      if (index === 0) return BIG
      throw new Error('no such net')
    })

    expect(loads).toEqual([{ index: 0, filename: BIG }])
  })

  it('resolves nothing when the engine reports no net at all', () => {
    expect(resolveNnueLoads(() => '')).toEqual([])
    expect(
      resolveNnueLoads(() => {
        throw new Error('engine not ready')
      }),
    ).toEqual([])
  })
})
