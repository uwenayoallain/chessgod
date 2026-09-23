import { describe, expect, it } from 'vite-plus/test'

import { readDashboardLayout, writeDashboardLayout } from './dashboard-layout'

function storageWith(values: Record<string, string>) {
  const stored = new Map(Object.entries(values))
  return {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value)
    },
    snapshot: () => Object.fromEntries(stored),
  }
}

describe('dashboard layout persistence', () => {
  it('falls back to stable defaults for missing or invalid values', () => {
    const storage = storageWith({
      'chessgod.activeTab': 'unknown',
      'chessgod.railWidth': '900',
      'chessgod.sidebarWidth': 'bad',
    })

    expect(readDashboardLayout(storage)).toEqual({
      activeTab: 'explore',
      railWidth: 400,
      sidebarCollapsed: false,
      sidebarWidth: 400,
    })
  })

  it('persists active tab, collapse state, and bounded widths', () => {
    const storage = storageWith({})

    writeDashboardLayout(storage, {
      activeTab: 'review',
      railWidth: 240,
      sidebarCollapsed: true,
      sidebarWidth: 520,
    })

    expect(readDashboardLayout(storage)).toEqual({
      activeTab: 'review',
      railWidth: 240,
      sidebarCollapsed: true,
      sidebarWidth: 520,
    })
  })

  it('maps legacy tab ids from before the 2-tab consolidation', () => {
    expect(readDashboardLayout(storageWith({ 'chessgod.activeTab': 'engine' })).activeTab).toBe(
      'explore',
    )
    expect(readDashboardLayout(storageWith({ 'chessgod.activeTab': 'stats' })).activeTab).toBe(
      'review',
    )
    expect(
      readDashboardLayout(storageWith({ 'chessgod.activeTab': 'recommendations' })).activeTab,
    ).toBe('review')
  })
})
