import { Card, CardBody, CardHeader } from '@/components/ui/card'

import { formatRelative, type ExternalCall, type ExternalState } from './types'

type Props = {
  calls: ExternalCall[]
  state: Record<string, ExternalState>
}

function CooldownBanner({ name, state }: { name: string; state: ExternalState }) {
  const cooldownUntil = state.cooldown_until ? Date.parse(state.cooldown_until) : null
  const inCooldown = cooldownUntil != null && cooldownUntil > Date.now()
  if (!inCooldown && !state.last_error) return null
  return (
    <div className={`callout ${inCooldown ? 'callout--warn' : ''}`}>
      <strong>{name}</strong>
      {inCooldown ? (
        <>
          {' '}
          — cooldown until {state.cooldown_until} (status {state.last_status_code ?? '?'})
        </>
      ) : null}
      {state.last_error ? <div className="muted">{state.last_error}</div> : null}
    </div>
  )
}

export function ExternalCallsTable({ calls, state }: Props) {
  return (
    <Card>
      <CardHeader>
        <h2>External Services</h2>
      </CardHeader>
      <CardBody className="column admin-observability__summary-body">
        {Object.entries(state).map(([name, value]) => (
          <CooldownBanner key={name} name={name} state={value} />
        ))}
        <table className="table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Operation</th>
              <th>Count</th>
              <th>Errors</th>
              <th>Error rate</th>
              <th>Avg</th>
              <th>p95</th>
              <th>Max</th>
              <th>Last status</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((row) => (
              <tr key={`${row.service}:${row.operation}`}>
                <td className="mono">{row.service}</td>
                <td className="mono">{row.operation}</td>
                <td>{row.count}</td>
                <td>{row.errors}</td>
                <td>{(row.error_rate * 100).toFixed(1)}%</td>
                <td>{row.avg_ms.toFixed(1)}ms</td>
                <td>{row.p95_ms.toFixed(1)}ms</td>
                <td>{row.max_ms.toFixed(1)}ms</td>
                <td>{row.last_status_code ?? '—'}</td>
                <td>{formatRelative(row.last_seen_at)}</td>
              </tr>
            ))}
            {calls.length === 0 ? (
              <tr>
                <td colSpan={10} className="muted">
                  No external calls recorded.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </CardBody>
    </Card>
  )
}
