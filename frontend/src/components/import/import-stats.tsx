import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { useImportSummary } from '@/hooks/use-import-summary'
import { useAppStore } from '@/store/app-store'

export function ImportStats() {
  const username = useAppStore((state) => state.username)
  const status = useAppStore((state) => state.importStatus)
  const { data } = useImportSummary(username, status)
  const hasLibrary = Boolean(data?.total_games)

  return (
    <Card>
      <CardHeader>
        <h2>{hasLibrary ? 'Library State' : 'Before You Start'}</h2>
      </CardHeader>
      <CardBody className="column">
        {hasLibrary ? (
          <>
            <div className="muted">Player</div>
            <div>{username ?? 'No active username'}</div>
            <div className="muted">Status</div>
            <div>{status}</div>
            <div className="muted">Imported games</div>
            <div>{(data?.total_games ?? 0).toLocaleString()}</div>
          </>
        ) : (
          <>
            <div className="muted">
              Imports are stored in the database as games arrive, so stopping midway keeps the games
              already written.
            </div>
            <div className="muted">
              Explorer, theory, and analysis unlock automatically after the first successful import.
            </div>
          </>
        )}
      </CardBody>
    </Card>
  )
}
