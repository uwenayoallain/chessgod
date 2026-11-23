import { formatRelative, type ObservabilitySnapshot } from './types'

type Props = {
  snapshot: ObservabilitySnapshot
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad'

function toneStyle(tone: Tone) {
  if (tone === 'good') return { color: 'var(--success)' }
  if (tone === 'warn') return { color: 'var(--warning)' }
  if (tone === 'bad') return { color: 'var(--danger)' }
  return undefined
}

function StatCard({
  label,
  value,
  tone = 'neutral',
  sub,
}: {
  label: string
  value: string | number
  tone?: Tone
  sub?: string | string[]
}) {
  const subItems = Array.isArray(sub) ? sub : sub ? [sub] : []
  return (
    <div className="stat-card">
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value" style={toneStyle(tone)}>
        {value}
      </div>
      {subItems.map((item) => (
        <div className="stat-card__label stat-card__sub" key={item}>
          {item}
        </div>
      ))}
    </div>
  )
}

export function StatGrid({ snapshot }: Props) {
  const { runtime, persistent } = snapshot
  const inflight = runtime.backend.inflight
  const maxInflight = runtime.backend.max_inflight
  const lag = runtime.system.event_loop_lag_ms
  const lagTone: Tone = lag == null ? 'neutral' : lag >= 100 ? 'bad' : lag >= 25 ? 'warn' : 'good'
  const rss = runtime.system.process.rss_mb
  const cpu = runtime.system.process.cpu_percent
  const slowQueriesNow = runtime.queries.slow_recent.length

  return (
    <div className="admin-observability__stats-grid">
      <StatCard label="Backend Requests" value={runtime.backend.total_requests} />
      <StatCard
        label="Inflight (now / peak)"
        value={`${inflight} / ${maxInflight}`}
        tone={inflight > 5 ? 'warn' : 'neutral'}
      />
      <StatCard
        label="Event-loop lag"
        value={lag == null ? '—' : `${lag.toFixed(2)}ms`}
        tone={lagTone}
        sub={`Last sample ${formatRelative(runtime.system.event_loop_lag_sampled_at)}`}
      />
      <StatCard
        label="Process RSS / CPU"
        value={rss == null ? '—' : `${rss.toFixed(0)} MB`}
        sub={[
          ...(cpu == null ? [] : [`CPU ${cpu.toFixed(1)}%`]),
          `Sampled ${formatRelative(runtime.system.process.sampled_at)}`,
        ]}
      />
      <StatCard
        label="Slow queries (recent)"
        value={slowQueriesNow}
        tone={slowQueriesNow > 0 ? 'warn' : 'good'}
      />
      <StatCard label="Frontend Runtime Events" value={runtime.frontend.total_events} />
      <StatCard label="Persisted Events" value={persistent.total_events} />
      <StatCard
        label="Backend 5xx (5m)"
        value={persistent.alerts.backend_5xx_last_5m}
        tone={persistent.alerts.backend_5xx_last_5m ? 'bad' : 'good'}
      />
      <StatCard
        label="Frontend Errors (5m)"
        value={persistent.alerts.frontend_errors_last_5m}
        tone={persistent.alerts.frontend_errors_last_5m ? 'bad' : 'good'}
      />
      <StatCard
        label="Slow Backend (1h)"
        value={persistent.alerts.slow_backend_requests_last_1h}
        tone={persistent.alerts.slow_backend_requests_last_1h ? 'warn' : 'good'}
      />
    </div>
  )
}
