import { describe, expect, it } from 'vite-plus/test'

import { shouldReloadForStaleChunk } from './stale-build'

describe('a stale build', () => {
  it('reloads once per failing chunk, never in a loop', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    expect(shouldReloadForStaleChunk(storage, 'a.js')).toBe(true)
    expect(shouldReloadForStaleChunk(storage, 'a.js')).toBe(false)
    // A different chunk after a later deploy reloads again.
    expect(shouldReloadForStaleChunk(storage, 'b.js')).toBe(true)
  })

  it('does not reload when storage is unavailable', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => undefined,
    }
    expect(shouldReloadForStaleChunk(broken, 'a.js')).toBe(false)
  })
})
