import { RefreshCw, Square } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useImport } from '@/hooks/use-import'
import { useAppStore } from '@/store/app-store'

export function ResyncButton({ username }: { username: string }) {
  const { status, startImport, stopImport, error } = useImport(username)
  const quiet = useAppStore((state) => state.importQuiet)
  // A quiet background sync keeps the button at rest.
  const isSyncing = status === 'running' && !quiet

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Button onClick={() => void startImport()} type="button" variant="ghost" disabled={isSyncing}>
        <RefreshCw size={14} className={isSyncing ? 'spin' : ''} />
        <span className="header__action-label" style={{ marginLeft: 6, fontSize: 13 }}>
          {isSyncing ? 'Syncing…' : 'Resync'}
        </span>
      </Button>
      {isSyncing ? (
        <Button
          onClick={() => void stopImport()}
          type="button"
          variant="ghost"
          aria-label="Stop import"
        >
          <Square size={12} />
          <span className="header__action-label" style={{ marginLeft: 6, fontSize: 13 }}>
            Stop
          </span>
        </Button>
      ) : null}
      {error ? (
        <span className="muted" style={{ fontSize: 12, color: 'var(--danger)' }}>
          {error}
        </span>
      ) : null}
      {status === 'complete' ? (
        <span className="muted" style={{ fontSize: 12, color: 'var(--success)' }}>
          Up to date
        </span>
      ) : null}
    </div>
  )
}
