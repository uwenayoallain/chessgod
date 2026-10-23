const ACTIVE_TABS = new Set(['explore', 'review'])

// Pre-consolidation tab ids stored in localStorage map onto the two new tabs.
const LEGACY_TAB_MAP: Record<string, string> = {
  openings: 'explore',
  games: 'explore',
  tree: 'explore',
  engine: 'explore',
  theory: 'review',
  recommendations: 'review',
  stats: 'review',
}

// Bumped when the default widths change: a stored width equal to an old
// default was never chosen by anybody (the layout is written on every render),
// so widths saved under an older version are dropped and recomputed.
const LAYOUT_VERSION = '2'

const DEFAULT_LAYOUT = {
  activeTab: 'explore',
  railWidth: 250,
  sidebarCollapsed: false,
  sidebarWidth: 400,
}

export const SIDEBAR_MIN = 320
export const SIDEBAR_MAX = 900
export const RAIL_MIN = 190
export const RAIL_MAX = 400

/**
 * Default widths for a viewport. Fixed 400/250 defaults gave the Review and
 * Explore sidebar — where all the training lives — under 300px of text on a
 * 1440px screen while the board took the rest: a third of the width to the
 * sidebar and a sixth to the rail leaves a board the height still bounds.
 */
export function defaultWidths(viewportWidth: number | undefined) {
  if (!viewportWidth || !Number.isFinite(viewportWidth)) {
    return { sidebarWidth: DEFAULT_LAYOUT.sidebarWidth, railWidth: DEFAULT_LAYOUT.railWidth }
  }
  return {
    sidebarWidth: clamp(Math.round(viewportWidth * 0.32), 400, 640),
    railWidth: clamp(Math.round(viewportWidth * 0.16), 220, 300),
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export type DashboardLayoutState = typeof DEFAULT_LAYOUT

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function readNumber(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return clamp(parsed, min, max)
}

function readActiveTab(value: string | null) {
  if (!value) return DEFAULT_LAYOUT.activeTab
  if (ACTIVE_TABS.has(value)) return value
  return LEGACY_TAB_MAP[value] ?? DEFAULT_LAYOUT.activeTab
}

export function getDashboardLayoutStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null
  return window.localStorage
}

export function readDashboardLayout(
  storage: Pick<StorageLike, 'getItem'> | null,
  viewportWidth: number | undefined = typeof window === 'undefined' ? undefined : window.innerWidth,
): DashboardLayoutState {
  const defaults = { ...DEFAULT_LAYOUT, ...defaultWidths(viewportWidth) }
  if (!storage) return defaults

  // Widths saved under an older layout version are old defaults, not choices.
  const currentVersion = storage.getItem('chessgod.layoutVersion') === LAYOUT_VERSION

  return {
    activeTab: readActiveTab(storage.getItem('chessgod.activeTab')),
    railWidth: currentVersion
      ? readNumber(storage.getItem('chessgod.railWidth'), defaults.railWidth, RAIL_MIN, RAIL_MAX)
      : defaults.railWidth,
    sidebarCollapsed: storage.getItem('chessgod.sidebarCollapsed') === 'true',
    sidebarWidth: currentVersion
      ? readNumber(
          storage.getItem('chessgod.sidebarWidth'),
          defaults.sidebarWidth,
          SIDEBAR_MIN,
          SIDEBAR_MAX,
        )
      : defaults.sidebarWidth,
  }
}

export function writeDashboardLayout(storage: StorageLike | null, layout: DashboardLayoutState) {
  if (!storage) return

  storage.setItem('chessgod.layoutVersion', LAYOUT_VERSION)
  storage.setItem('chessgod.activeTab', readActiveTab(layout.activeTab))
  storage.setItem('chessgod.sidebarCollapsed', String(layout.sidebarCollapsed))
  storage.setItem(
    'chessgod.sidebarWidth',
    String(clamp(layout.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX)),
  )
  storage.setItem('chessgod.railWidth', String(clamp(layout.railWidth, RAIL_MIN, RAIL_MAX)))
}
