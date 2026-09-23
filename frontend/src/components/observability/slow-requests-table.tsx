import { Card, CardBody, CardHeader } from '@/components/ui/card'

import { formatRelative, type SlowRequest } from './types'

type Props = {
  rows: SlowRequest[]
  onSelectRequestId?: (requestId: string) => void
}

export function SlowRequestsTable({ rows, onSelectRequestId }: Props) {
  return (
    <Card>
      <CardHeader>
        <h2>Slow / Heavy Requests</h2>
      </CardHeader>
      <CardBody>
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Route</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Queries</th>
              <th>Request ID</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 50).map((row, idx) => (
              <tr key={`${row.request_id ?? row.path}:${idx}`}>
                <td>{formatRelative(row.ts)}</td>
                <td className="mono">
                  {row.method} {row.path}
                </td>
                <td>{row.status_code ?? '—'}</td>
                <td>{row.duration_ms.toFixed(1)}ms</td>
                <td>
                  {row.query_count ?? 0}
                  {row.high_query_count ? <span className="muted"> N+1</span> : null}
                </td>
                <td className="mono">
                  {row.request_id ? (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => row.request_id && onSelectRequestId?.(row.request_id)}
                    >
                      {row.request_id.slice(0, 8)}…
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No slow requests recorded.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </CardBody>
    </Card>
  )
}
