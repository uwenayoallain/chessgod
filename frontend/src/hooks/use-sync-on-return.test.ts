import { describe, expect, it } from 'vite-plus/test'

import { SYNC_ON_RETURN_AFTER_MS, shouldSyncOnReturn } from './use-sync-on-return'

describe('shouldSyncOnReturn', () => {
  it('syncs on a return after a few minutes away, never during an import', () => {
    expect(shouldSyncOnReturn(0, SYNC_ON_RETURN_AFTER_MS, false)).toBe(true)
    expect(shouldSyncOnReturn(0, SYNC_ON_RETURN_AFTER_MS - 1, false)).toBe(false)
    expect(shouldSyncOnReturn(0, SYNC_ON_RETURN_AFTER_MS * 10, true)).toBe(false)
  })
})
