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
      railWidth: 250,
      sidebarCollapsed: false,
      sidebarWidth: 400,
    })
  })

  it('sizes the panels from the viewport when nothing was chosen', () => {
    expect(readDashboardLayout(storageWith({}), 1440)).toMatchObject({
      sidebarWidth: 461,
      railWidth: 230,
    })
    // Narrow and wide screens are held inside the usable range.
    expect(readDashboardLayout(storageWith({}), 1000)).toMatchObject({
      sidebarWidth: 400,
      railWidth: 220,
    })
    expect(readDashboardLayout(storageWith({}), 2560)).toMatchObject({
      sidebarWidth: 640,
      railWidth: 300,
    })
  })

  it('drops widths saved under an older layout version', () => {
    // The layout is written on every render, so a width equal to the old
    // default was stored without anybody choosing it.
    const storage = storageWith({
      'chessgod.sidebarWidth': '400',
      'chessgod.railWidth': '250',
    })
    expect(readDashboardLayout(storage, 1440)).toMatchObject({
      sidebarWidth: 461,
      railWidth: 230,
    })
    writeDashboardLayout(storage, {
      activeTab: 'explore',
      railWidth: 250,
      sidebarCollapsed: false,
      sidebarWidth: 400,
    })
    expect(readDashboardLayout(storage, 1440)).toMatchObject({
      sidebarWidth: 400,
      railWidth: 250,
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
