import { Card, CardBody, CardHeader } from '@/components/ui/card'

import { formatRelative, type ObservabilityRoute, type StatusBuckets } from './types'

type Props = {
  routes: ObservabilityRoute[]
}

function StatusBucketBar({
  buckets,
  total,
}: {
  buckets: StatusBuckets | undefined
  total: number
}) {
  if (!buckets || total === 0) return <span className="muted">—</span>
  const candidates: Array<{ key: keyof StatusBuckets; color: string; count: number }> = [
    { key: '2xx', color: 'var(--success, #10b981)', count: buckets['2xx'] ?? 0 },
    { key: '3xx', color: 'var(--accent, #3b82f6)', count: buckets['3xx'] ?? 0 },
    { key: '4xx', color: 'var(--warning, #f59e0b)', count: buckets['4xx'] ?? 0 },
    { key: '5xx', color: 'var(--danger, #ef4444)', count: buckets['5xx'] ?? 0 },
  ]
  const segments = candidates.filter((segment) => segment.count > 0)
  return (
    <div className="status-bucket-bar" title={segments.map((s) => `${s.key}=${s.count}`).join(' ')}>
      {segments.map((segment) => (
        <span
          key={segment.key}
          className="status-bucket-bar__segment"
          style={{ width: `${(segment.count / total) * 100}%`, background: segment.color }}
        />
      ))}
    </div>
  )
}

export function RoutesTable({ routes }: Props) {
  return (
    <Card>
      <CardHeader>
        <h2>Top Backend Routes</h2>
      </CardHeader>
      <CardBody>
        <table className="table">
          <thead>
            <tr>
              <th>Route</th>
              <th>Count</th>
              <th>Avg</th>
              <th>p50</th>
              <th>p95</th>
              <th>p99</th>
              <th>Max</th>
              <th>Status mix</th>
              <th>Errors</th>
              <th>Queries (last/max)</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {routes.slice(0, 20).map((route) => (
              <tr key={`${route.method}:${route.path}`}>
                <td className="mono">
                  {route.method} {route.path}
                </td>
                <td>{route.count}</td>
                <td>{route.avg_duration_ms.toFixed(1)}ms</td>
                <td>{route.p50_duration_ms.toFixed(1)}ms</td>
                <td>{route.p95_duration_ms.toFixed(1)}ms</td>
                <td>{route.p99_duration_ms.toFixed(1)}ms</td>
                <td>{route.max_duration_ms.toFixed(1)}ms</td>
                <td>
                  <StatusBucketBar buckets={route.status_buckets} total={route.count} />
                </td>
                <td>{route.errors}</td>
                <td>
                  {route.last_query_count ?? 0} / {route.max_query_count ?? 0}
                  {route.high_query_count_total ? (
                    <span className="muted"> ({route.high_query_count_total} N+1)</span>
                  ) : null}
                </td>
                <td>{formatRelative(route.last_seen_at)}</td>
              </tr>
            ))}
            {routes.length === 0 ? (
              <tr>
                <td colSpan={11} className="muted">
                  No requests recorded yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </CardBody>
    </Card>
  )
}
