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

const DEFAULT_LAYOUT = {
  activeTab: 'explore',
  railWidth: 250,
  sidebarCollapsed: false,
  sidebarWidth: 400,
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
): DashboardLayoutState {
  if (!storage) return DEFAULT_LAYOUT

  return {
    activeTab: readActiveTab(storage.getItem('chessgod.activeTab')),
    railWidth: readNumber(
      storage.getItem('chessgod.railWidth'),
      DEFAULT_LAYOUT.railWidth,
      160,
      400,
    ),
    sidebarCollapsed: storage.getItem('chessgod.sidebarCollapsed') === 'true',
    sidebarWidth: readNumber(
      storage.getItem('chessgod.sidebarWidth'),
      DEFAULT_LAYOUT.sidebarWidth,
      260,
      800,
    ),
  }
}

export function writeDashboardLayout(storage: StorageLike | null, layout: DashboardLayoutState) {
  if (!storage) return

  storage.setItem('chessgod.activeTab', readActiveTab(layout.activeTab))
  storage.setItem('chessgod.sidebarCollapsed', String(layout.sidebarCollapsed))
  storage.setItem('chessgod.sidebarWidth', String(clamp(layout.sidebarWidth, 260, 800)))
  storage.setItem('chessgod.railWidth', String(clamp(layout.railWidth, 160, 400)))
}
