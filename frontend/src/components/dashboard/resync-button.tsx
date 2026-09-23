import { RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useImport } from '@/hooks/use-import'

export function ResyncButton({ username }: { username: string }) {
  const { status, startImport, error } = useImport(username)
  const isSyncing = status === 'running'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Button onClick={() => void startImport()} type="button" variant="ghost" disabled={isSyncing}>
        <RefreshCw size={14} className={isSyncing ? 'spin' : ''} />
        <span className="header__action-label" style={{ marginLeft: 6, fontSize: 13 }}>
          {isSyncing ? 'Syncing…' : 'Resync'}
        </span>
      </Button>
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
