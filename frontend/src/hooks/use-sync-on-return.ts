import { useEffect, useRef } from 'react'

import { useImport } from '@/hooks/use-import'
import { useAppStore } from '@/store/app-store'

/**
 * Coming back this long after the last sync fetches the games played
 * meanwhile. A rapid game is ten minutes a side, so a shorter gap mostly found
 * nothing and still flashed the sync banner at the player.
 */
export const SYNC_ON_RETURN_AFTER_MS = 15 * 60 * 1000

export function shouldSyncOnReturn(lastSyncAt: number, now: number, running: boolean): boolean {
  return !running && now - lastSyncAt >= SYNC_ON_RETURN_AFTER_MS
}

/**
 * Fetches new games when the player comes back to the app. The habit that
 * matters most between games, stopping after a few in a row, can only be
 * read from games the app has; the server's own sync runs every three hours,
 * which is a whole sitting late. A return costs one or two Chess.com archive
 * reads and nothing at all when nothing was played.
 */
export function useSyncOnReturn(username: string) {
  const { startImport } = useImport(username)
  const status = useAppStore((state) => state.importStatus)
  // Landing on the workspace counts as a sync: the server syncs players in use.
  const lastSync = useRef(Date.now())
  const start = useRef(startImport)
  start.current = startImport
  const running = useRef(false)
  running.current = status === 'running'

  useEffect(() => {
    if (status === 'running' || status === 'complete') lastSync.current = Date.now()
  }, [status])

  useEffect(() => {
    function onReturn() {
      if (document.visibilityState !== 'visible') return
      if (!shouldSyncOnReturn(lastSync.current, Date.now(), running.current)) return
      lastSync.current = Date.now()
      // Quiet: the player did not ask; they only hear about games that arrived.
      void start.current({ quiet: true })
    }
    document.addEventListener('visibilitychange', onReturn)
    window.addEventListener('focus', onReturn)
    return () => {
      document.removeEventListener('visibilitychange', onReturn)
      window.removeEventListener('focus', onReturn)
    }
  }, [])
}
