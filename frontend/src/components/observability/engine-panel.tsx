import { Card, CardBody, CardHeader } from '@/components/ui/card'

import { formatNumber, formatRelative, type EngineMetrics } from './types'

type Props = {
  metrics: EngineMetrics
}

export function EnginePanel({ metrics }: Props) {
  return (
    <Card>
      <CardHeader>
        <h2>Analysis engine</h2>
      </CardHeader>
      <CardBody>
        <div className="admin-observability__stats-grid">
          <div className="stat-card">
            <div className="stat-card__label">Completions</div>
            <div className="stat-card__value">{metrics.completions}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">Errors</div>
            <div
              className={`stat-card__value ${metrics.errors ? 'admin-observability__danger-text' : ''}`}
            >
              {metrics.errors}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">Avg duration</div>
            <div className="stat-card__value">{metrics.avg_duration_ms.toFixed(0)}ms</div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">p95 duration</div>
            <div className="stat-card__value">{metrics.p95_duration_ms.toFixed(0)}ms</div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">Last NPS</div>
            <div className="stat-card__value">{formatNumber(metrics.last_nps)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">Last depth</div>
            <div className="stat-card__value">{metrics.last_depth ?? '—'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">MultiPV</div>
            <div className="stat-card__value">{metrics.last_multi_pv ?? '—'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card__label">Queue depth (last)</div>
            <div className="stat-card__value">{metrics.last_queue_depth ?? 0}</div>
          </div>
        </div>
        <div className="muted admin-observability__panel-footnote">
          Last seen {formatRelative(metrics.last_seen_at)}
        </div>
      </CardBody>
    </Card>
  )
}
