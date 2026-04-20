import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Table } from '@/components/ui/table'
import type { TheoryDeviation } from '@/hooks/use-theory'
import { useAppStore } from '@/store/app-store'

function formatWinRate(rate: number | null | undefined) {
  if (rate == null) {
    return 'n/a'
  }
  return `${(rate * 100).toFixed(0)}%`
}

function severityTone(severity: TheoryDeviation['severity']) {
  if (severity === 'major') return 'var(--danger)'
  if (severity === 'moderate') return 'var(--warning)'
  return 'var(--draw)'
}

export function DeviationTable({
  deviations,
  isLoading,
}: {
  deviations: TheoryDeviation[]
  isLoading: boolean
}) {
  const pushPosition = useAppStore((state) => state.pushPosition)

  return (
    <Card>
      <CardHeader>
        <h2>Deviation Scan</h2>
        <span className="muted">{deviations.length} positions</span>
      </CardHeader>
      <CardBody>
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
            {isLoading ? (
              <tr>
                <td className="muted" colSpan={5}>Scanning theory deviations…</td>
              </tr>
            ) : null}
            {!isLoading && !deviations.length ? (
              <tr>
                <td className="muted" colSpan={5}>No deviations found for the selected side yet.</td>
              </tr>
            ) : null}
            {deviations.map((deviation) => (
              <tr key={`${deviation.fen}-${deviation.move_number}`}>
                <td>
                  <button className="button button--ghost" onClick={() => pushPosition(deviation.fen)} type="button">
                    {deviation.move_number}
                  </button>
                </td>
                <td>
                  <button className="button button--ghost" onClick={() => pushPosition(deviation.fen)} type="button">
                    {deviation.user_top_move.san} · {formatWinRate(deviation.user_top_move.win_rate)}
                  </button>
                </td>
                <td>
                  <button className="button button--ghost" onClick={() => pushPosition(deviation.fen)} type="button">
                    {deviation.master_top_move.san} · {formatWinRate(deviation.master_top_move.win_rate)}
                  </button>
                </td>
                <td>{deviation.opening_name ?? deviation.eco ?? 'Unknown'}</td>
                <td style={{ color: severityTone(deviation.severity), fontWeight: 600 }}>{deviation.severity}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </CardBody>
    </Card>
  )
}
