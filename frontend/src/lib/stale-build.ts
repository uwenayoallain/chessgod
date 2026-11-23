/**
 * A tab opened before a deploy holds an index that names chunks the new build
 * no longer ships: the first lazy page opened after a rebuild fails with
 * "Failed to fetch dynamically imported module" and, uncaught, React unmounts
 * the whole tree. The page went blank and only a reload brought it back.
 *
 * Vite raises `vite:preloadError` for exactly this. Reloading fetches the new
 * index, whose chunks exist. The guard reloads once per failing chunk so a
 * chunk that is genuinely missing cannot loop the tab.
 */
const KEY = 'chessgod.reloaded-for-chunk'

export function shouldReloadForStaleChunk(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  chunk: string,
): boolean {
  try {
    if (storage.getItem(KEY) === chunk) return false
    storage.setItem(KEY, chunk)
    return true
  } catch {
    return false
  }
}

export function installStaleBuildReload(): void {
  window.addEventListener('vite:preloadError', (event) => {
    const chunk = String(
      (event as unknown as { payload?: { message?: string } }).payload?.message ?? 'chunk',
    )
    if (!shouldReloadForStaleChunk(window.sessionStorage, chunk)) return
    event.preventDefault()
    window.location.reload()
  })
}
