import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { isMuted, play, setMuted } from './sound'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

describe('sound', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: memoryStorage() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('remembers the mute switch', () => {
    setMuted(true)
    expect(isMuted()).toBe(true)
    setMuted(false)
    expect(isMuted()).toBe(false)
  })

  it('is silent, not broken, where there is no audio or it is muted', () => {
    expect(() => play('right')).not.toThrow()
    const created = vi.fn()
    vi.stubGlobal('window', { localStorage: memoryStorage(), AudioContext: created })
    setMuted(true)
    play('promotion')
    expect(created).not.toHaveBeenCalled()
  })
})
