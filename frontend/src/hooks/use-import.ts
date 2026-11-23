import { useState } from 'react'

import { api } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-errors'
import { describeImportError } from '@/lib/import-errors'
import { reduceImportProgress, type ImportEvent } from '@/lib/import-progress'
import { queryClient } from '@/lib/query-client'
import { useAppStore } from '@/store/app-store'

export function useImport(username: string) {
  const [error, setError] = useState<string | null>(null)
  const { importStatus, importProgress, setImportStatus, setImportProgress, setImportQuiet } =
    useAppStore()

  /**
   * `quiet`: a sync nobody asked for. It shows nothing while it runs and
   * leaves no "complete" state behind unless games arrived; the player only
   * ever sees a sync that changed something.
   */
  async function startImport(options?: { force?: boolean; quiet?: boolean }) {
    if (!username.trim()) {
      setError('Enter a Chess.com username.')
      return
    }

    setError(null)
    setImportQuiet(Boolean(options?.quiet))
    setImportStatus('running')
    setImportProgress(null)

    try {
      await api.post(`/api/import/${username}`, undefined, {
        params: { force: options?.force ?? false },
      })
      const source = new EventSource(
        `${import.meta.env.VITE_API_URL ?? ''}/api/import/${username}/status`,
      )
      source.onmessage = (event) => {
        let payload: ImportEvent
        try {
          payload = JSON.parse(event.data) as ImportEvent
        } catch {
          console.warn('[chessgod] Malformed SSE event data:', event.data)
          return
        }
        if (
          payload.type === 'archive_start' ||
          payload.type === 'game_progress' ||
          payload.type === 'archive_complete' ||
          payload.type === 'complete'
        ) {
          setImportProgress(reduceImportProgress(useAppStore.getState().importProgress, payload))
        }
        if (payload.type === 'archive_complete' && (payload.new_games ?? 0) > 0) {
          // Games arrived: a quiet sync becomes a visible one, so the result shows.
          setImportQuiet(false)
          void queryClient.invalidateQueries()
        }
        if (payload.type === 'complete') {
          const arrived = (payload.total_new_games ?? 0) > 0
          if (arrived) setImportQuiet(false)
          // A quiet sync that found nothing leaves no trace.
          setImportStatus(useAppStore.getState().importQuiet && !arrived ? 'idle' : 'complete')
          source.close()
          // A sync that found nothing changed nothing; refetching every query
          // on each return to the app would only make the app feel slower.
          if ((payload.total_new_games ?? 1) > 0) void queryClient.invalidateQueries()
        }
        if (payload.type === 'error') {
          setImportStatus('error')
          setError(describeImportError(String(payload.message ?? 'Import failed'), username))
          source.close()
        }
        if (payload.type === 'cancelled') {
          // Archives already committed stay imported; the next run skips them
          setImportStatus('idle')
          source.close()
          void queryClient.invalidateQueries()
        }
      }
      source.onerror = () => {
        setImportStatus('error')
        setError('The import stream disconnected. Check that the backend is running and try again.')
        source.close()
      }
    } catch (caught) {
      setImportStatus('error')
      setError(describeImportError(getApiErrorMessage(caught, 'Import failed'), username))
    }
  }

  async function stopImport() {
    if (!username.trim()) return
    try {
      await api.post(`/api/import/${username}/stop`)
      // The status stream delivers the `cancelled` event and resets the state
    } catch (caught) {
      setError(getApiErrorMessage(caught, 'Could not stop the import'))
    }
  }

  return { status: importStatus, progress: importProgress, startImport, stopImport, error }
}
