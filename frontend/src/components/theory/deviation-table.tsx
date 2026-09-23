import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { PanelError } from '@/components/ui/panel-error'
import { Table } from '@/components/ui/table'
import type { TheoryDeviation } from '@/hooks/use-theory'
import { useAppStore } from '@/store/app-store'

function formatWinRate(rate: number | null | undefined) {
  if (rate == null) {
    return 'n/a'
  }
  return `${(rate * 100).toFixed(0)}%`
}

export function DeviationTable({
  deviations,
  error,
  isLoading,
  isRefreshing = false,
}: {
  deviations: TheoryDeviation[]
  error?: unknown
  isLoading: boolean
  isRefreshing?: boolean
}) {
  const pushPosition = useAppStore((state) => state.pushPosition)

  return (
    <Card>
      <CardHeader>
        <h2>Theory deviations</h2>
        <div className="panel-header__meta">
          {isRefreshing ? <span className="refresh-badge">Updating</span> : null}
          <span className="muted">{deviations.length} positions</span>
        </div>
      </CardHeader>
      {/* One fixed-height region for every state this panel can be in. The scan
          returns anywhere from nothing to a couple of hundred rows, so sizing to
          content moves everything below it each time the colour or filter
          changes — and a six-row skeleton growing into 150 table rows is the
          same shift by another name. */}
      <CardBody className="panel-region">
        {isLoading ? <PanelSkeleton label="Loading the theory scan" rows={6} /> : null}
        {error && !deviations.length && !isLoading ? (
          <PanelError error={error} what="the theory scan" />
        ) : null}
        {!isLoading && !error && !deviations.length ? (
          <EmptyState
            title="No deviations found"
            message="Nothing you play as this color departs from master practice. Try the other color, or import more games."
          />
        ) : null}
        {!isLoading && deviations.length ? (
          <div className="table-scroll table-scroll--fill">
            <Table>
              <thead>
                <tr>
                  <th>Move</th>
                  <th>Your move</th>
                  <th>Master move</th>
                  <th>Opening</th>
                  <th>Severity</th>
                </tr>
              </thead>
              <tbody>
                {deviations.map((deviation) => (
                  <tr key={`${deviation.fen}-${deviation.move_number}`}>
                    <td>
                      <button
                        className="button button--ghost"
                        onClick={() => pushPosition(deviation.fen)}
                        type="button"
                      >
                        {deviation.move_number}
                      </button>
                    </td>
                    <td>
                      <button
                        className="button button--ghost"
                        onClick={() => pushPosition(deviation.fen)}
                        type="button"
                      >
                        {deviation.user_top_move.san} ·{' '}
                        {formatWinRate(deviation.user_top_move.win_rate)}
                      </button>
                    </td>
                    <td>
                      <button
                        className="button button--ghost"
                        onClick={() => pushPosition(deviation.fen)}
                        type="button"
                      >
                        {deviation.master_top_move.san} ·{' '}
                        {formatWinRate(deviation.master_top_move.win_rate)}
                      </button>
                    </td>
                    <td>{deviation.opening_name ?? deviation.eco ?? 'Unknown'}</td>
                    <td className={`severity--${deviation.severity}`}>{deviation.severity}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}
