/**
 * `localStorage` that cannot throw. A browser with site data blocked (a
 * private window, a strict cookie setting, an embedded frame) throws on the
 * `localStorage` accessor itself, and an uncaught throw while a store or a
 * provider initialises blanks the whole app. Every remembered preference here
 * is a convenience: a refused read is "nothing stored", a refused write lasts
 * for this visit only.
 */
function store(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage ?? null
  } catch {
    return null
  }
}

export function safeGetItem(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** True when the value was stored. */
export function safeSetItem(key: string, value: string): boolean {
  try {
    const target = store()
    if (!target) return false
    target.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/** True when the key is gone (or was never there). */
export function safeRemoveItem(key: string): boolean {
  try {
    const target = store()
    if (!target) return false
    target.removeItem(key)
    return true
  } catch {
    return false
  }
}
