import { Card, CardBody, CardHeader } from '@/components/ui/card'

import { formatRelative, type QueryTemplate, type SlowQuery } from './types'

type Props = {
  templates: QueryTemplate[]
  slow: SlowQuery[]
}

export function QueriesPanel({ templates, slow }: Props) {
  return (
    <Card>
      <CardHeader>
        <h2>Database queries</h2>
      </CardHeader>
      <CardBody className="column admin-observability__panel-stack">
        <div>
          <div className="section-subtitle">Top templates by total time</div>
          <table className="table">
            <thead>
              <tr>
                <th>Template</th>
                <th>Count</th>
                <th>Avg</th>
                <th>p95</th>
                <th>Max</th>
                <th>Total</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {templates.slice(0, 20).map((row) => (
                <tr key={row.template}>
                  <td className="mono admin-observability__query-cell" title={row.template}>
                    {row.template}
                  </td>
                  <td>{row.count}</td>
                  <td>{row.avg_ms.toFixed(2)}ms</td>
                  <td>{row.p95_ms.toFixed(2)}ms</td>
                  <td>{row.max_ms.toFixed(2)}ms</td>
                  <td>{row.total_ms.toFixed(0)}ms</td>
                  <td>{formatRelative(row.last_seen_at)}</td>
                </tr>
              ))}
              {templates.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    No queries recorded yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div>
          <div className="section-subtitle">Recent slow queries</div>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Duration</th>
                <th>Template</th>
              </tr>
            </thead>
            <tbody>
              {slow.slice(0, 50).map((row, idx) => (
                <tr key={`${row.ts}:${idx}`}>
                  <td>{formatRelative(row.ts)}</td>
                  <td>{row.duration_ms.toFixed(2)}ms</td>
                  <td className="mono" title={row.template}>
                    {row.template}
                  </td>
                </tr>
              ))}
              {slow.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    No slow queries recorded.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}
