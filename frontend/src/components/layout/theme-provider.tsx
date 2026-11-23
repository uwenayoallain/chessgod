import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react'

import { safeGetItem, safeSetItem } from '@/lib/storage'

type Theme = 'dark' | 'light' | 'system'
type Resolved = 'dark' | 'light'

type ThemeContextValue = {
  theme: Theme
  setTheme: (theme: Theme) => void
  cycleTheme: () => void
}

/** Shared with the inline script in `index.html`, which applies it before first paint. */
export const THEME_STORAGE_KEY = 'chessgod-theme'

/**
 * The page background per theme (`--bg` in `index.css`), for the browser's own
 * chrome: the address bar on a phone, the title bar of an installed app. The
 * meta tag was fixed at the dark value, so a light page sat under a dark bar.
 * The same two values are in the inline script in `index.html`.
 */
export const THEME_COLORS: Record<Resolved, string> = { dark: '#21201d', light: '#edebe9' }

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function readStoredTheme(): Theme {
  const stored = safeGetItem(THEME_STORAGE_KEY)
  return stored === 'dark' || stored === 'light' || stored === 'system' ? stored : 'system'
}

function systemTheme(): Resolved {
  // No matchMedia (an old browser, a test environment) means no preference
  // to read; the app's default is dark.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function resolveTheme(theme: Theme): Resolved {
  return theme === 'system' ? systemTheme() : theme
}

/** Put a theme on the document: the class the stylesheet keys on, and the browser's own colours. */
export function applyTheme(resolved: Resolved) {
  const root = window.document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(resolved)
  root.style.colorScheme = resolved
  window.document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLORS[resolved])
}

export function ThemeProvider({ children }: PropsWithChildren) {
  // Read through the safe helper: with site data blocked, `localStorage`
  // throws on access, and thrown from this initialiser it blanked the app.
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)

  useEffect(() => {
    applyTheme(resolveTheme(theme))
  }, [theme])

  useEffect(() => {
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = () => applyTheme(mediaQuery.matches ? 'dark' : 'light')
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme])

  const setTheme = (newTheme: Theme) => {
    // A refused write keeps the choice for this visit.
    safeSetItem(THEME_STORAGE_KEY, newTheme)
    setThemeState(newTheme)
  }

  const cycleTheme = () => {
    if (theme === 'system') setTheme('light')
    else if (theme === 'light') setTheme('dark')
    else setTheme('system')
  }

  const value = {
    theme,
    setTheme,
    cycleTheme,
  }

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const value = useContext(ThemeContext)
  if (!value) {
    throw new Error('ThemeProvider missing')
  }
  return value
}
