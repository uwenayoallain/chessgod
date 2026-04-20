import { useState } from 'react'

import { api } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-errors'
import { reduceImportProgress, type ImportEvent } from '@/lib/import-progress'
import { useAppStore } from '@/store/app-store'

export function useImport(username: string) {
  const [error, setError] = useState<string | null>(null)
  const { importStatus, importProgress, setImportStatus, setImportProgress } = useAppStore()

  async function startImport(options?: { force?: boolean }) {
    if (!username.trim()) {
      setError('Enter a Chess.com username.')
      return
    }

    setError(null)
    setImportStatus('running')
    setImportProgress(null)

    try {
      await api.post(`/api/import/${username}`, undefined, { params: { force: options?.force ?? false } })
      const source = new EventSource(`${import.meta.env.VITE_API_URL ?? ''}/api/import/${username}/status`)
      source.onmessage = (event) => {
        let payload: ImportEvent
        try {
          payload = JSON.parse(event.data) as ImportEvent
        } catch {
          console.warn('[chessgod] Malformed SSE event data:', event.data)
          return
        }
        if (payload.type === 'archive_start' || payload.type === 'game_progress' || payload.type === 'archive_complete' || payload.type === 'complete') {
          setImportProgress(reduceImportProgress(useAppStore.getState().importProgress, payload))
        }
        if (payload.type === 'complete') {
          setImportStatus('complete')
          source.close()
        }
        if (payload.type === 'error') {
          setImportStatus('error')
          setError(String(payload.message ?? 'Import failed'))
          source.close()
        }
      }
      source.onerror = () => {
        setImportStatus('error')
        setError('The import stream disconnected. Check that the backend is running and try again.')
        source.close()
      }
    } catch (caught) {
      setImportStatus('error')
      setError(getApiErrorMessage(caught, 'Import failed'))
    }
  }

  return { status: importStatus, progress: importProgress, startImport, error }
}
