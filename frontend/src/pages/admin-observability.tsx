import axios from 'axios'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-errors'

type ObservabilityRoute = {
  method: string
  path: string
  count: number
  errors: number
  avg_duration_ms: number
  max_duration_ms: number
  last_status_code: number | null
  last_duration_ms: number
  last_seen_at: string | null
}

type ObservabilityEvent = {
  id?: number
  created_at?: string
  source?: string
  kind?: string
  name?: string
  severity?: string | null
  request_id?: string | null
  method?: string | null
  path?: string | null
  status_code?: number | null
  duration_ms?: number | null
  message?: string | null
  url?: string | null
  meta?: Record<string, unknown> | null
}

type ObservabilitySnapshot = {
  request_id: string
  generated_at: string
  runtime: {
    uptime_seconds: number
    backend: {
      total_requests: number
      routes: ObservabilityRoute[]
      recent_errors: ObservabilityEvent[]
    }
    frontend: {
      total_events: number
      events_by_kind: Record<string, number>
      events_by_severity: Record<string, number>
      recent_events: ObservabilityEvent[]
    }
  }
  persistent: {
    total_events: number
    events_by_source: Record<string, number>
    alerts: {
      backend_5xx_last_5m: number
      frontend_errors_last_5m: number
      slow_backend_requests_last_1h: number
    }
    recent_events: ObservabilityEvent[]
  }
}

const ADMIN_PASSPHRASE_STORAGE_KEY = 'chessgod.observabilityPassphrase'

function readStoredPassphrase() {
  if (typeof window === 'undefined') {
    return null
  }
  const value = window.sessionStorage.getItem(ADMIN_PASSPHRASE_STORAGE_KEY)
  return value && value.trim() ? value.trim() : null
}

function storePassphrase(value: string) {
  if (typeof window === 'undefined') {
    return
  }
  window.sessionStorage.setItem(ADMIN_PASSPHRASE_STORAGE_KEY, value)
}

function clearStoredPassphrase() {
  if (typeof window === 'undefined') {
    return
  }
  window.sessionStorage.removeItem(ADMIN_PASSPHRASE_STORAGE_KEY)
}

function formatRelative(iso: string | null | undefined) {
  if (!iso) return 'n/a'
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return iso
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`
  return `${Math.floor(deltaSeconds / 3600)}h ago`
}

function severityClass(severity: string | null | undefined) {
  if (severity === 'error') return 'admin-observability__severity admin-observability__severity--error'
  if (severity === 'warn') return 'admin-observability__severity admin-observability__severity--warn'
  return 'admin-observability__severity'
}

export default function AdminObservabilityPage() {
  const [passphraseInput, setPassphraseInput] = useState('')
  const [isUnlocked, setIsUnlocked] = useState(() => readStoredPassphrase() != null)
  const [snapshot, setSnapshot] = useState<ObservabilitySnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const fetchSnapshot = async (passphrase: string) =>
    api.get<ObservabilitySnapshot>('/api/health/observability', {
      headers: {
        'X-Admin-Passphrase': passphrase,
      },
    })

  const unlock = async () => {
    const candidate = passphraseInput.trim()
    if (!candidate) {
      setError('Enter admin passphrase')
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const response = await fetchSnapshot(candidate)
      storePassphrase(candidate)
      setIsUnlocked(true)
      setPassphraseInput('')
      setSnapshot(response.data)
    } catch (caught) {
      clearStoredPassphrase()
      setIsUnlocked(false)
      setError(getApiErrorMessage(caught, 'Failed to load observability snapshot'))
      setSnapshot(null)
    } finally {
      setIsLoading(false)
    }
  }

  const loadFromSession = async () => {
    const stored = readStoredPassphrase()
    if (!stored) {
      setIsUnlocked(false)
      setSnapshot(null)
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const response = await fetchSnapshot(stored)
      setSnapshot(response.data)
    } catch (caught) {
      const statusCode = axios.isAxiosError(caught) ? caught.response?.status : undefined
      if (statusCode === 401 || statusCode === 403) {
        clearStoredPassphrase()
        setIsUnlocked(false)
        setSnapshot(null)
        setError('Passphrase rejected. Enter it again to unlock the admin page.')
      } else {
        setError(getApiErrorMessage(caught, 'Failed to refresh observability snapshot'))
      }
    } finally {
      setIsLoading(false)
    }
  }

  const lock = () => {
    clearStoredPassphrase()
    setIsUnlocked(false)
    setPassphraseInput('')
    setSnapshot(null)
    setError(null)
    setSearch('')
  }

  useEffect(() => {
    if (!isUnlocked) return
    void loadFromSession()
    const timer = window.setInterval(() => void loadFromSession(), 10000)
    return () => window.clearInterval(timer)
  }, [isUnlocked])

  const filteredEvents = useMemo(() => {
    if (!snapshot) return []
    const term = search.trim().toLowerCase()
    if (!term) return snapshot.persistent.recent_events
    return snapshot.persistent.recent_events.filter((event) => {
      const values = [
        event.request_id,
        event.name,
        event.kind,
        event.source,
        event.path,
        event.message,
        event.status_code != null ? String(event.status_code) : null,
      ]
      return values.some((value) => value?.toLowerCase().includes(term))
    })
  }, [search, snapshot])

  if (!isUnlocked) {
    return (
      <div className="admin-observability-page admin-observability-page--locked">
        <Card className="admin-observability-lock-card">
          <CardHeader>
            <h2>Admin Observability</h2>
          </CardHeader>
          <CardBody className="column" style={{ gap: 14 }}>
            <div className="muted" style={{ lineHeight: 1.55 }}>
              Enter the admin passphrase to unlock observability data.
            </div>
            <Input
              type="password"
              value={passphraseInput}
              onChange={(event) => setPassphraseInput(event.target.value)}
              placeholder="Enter admin passphrase"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isLoading) {
                  void unlock()
                }
              }}
            />
            <Button variant="primary" onClick={() => void unlock()} disabled={isLoading || passphraseInput.trim().length === 0}>
              {isLoading ? 'Unlocking...' : 'Unlock'}
            </Button>
            {error ? <div className="admin-observability__error">{error}</div> : null}
          </CardBody>
        </Card>
      </div>
    )
  }

  return (
    <div className="admin-observability-page">
      <div className="admin-observability-page__shell">
        <Card>
          <CardHeader>
            <h2>Observability Admin</h2>
          </CardHeader>
          <CardBody className="column" style={{ gap: 12 }}>
            <div className="stack" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="admin-observability__meta">Session unlocked</div>
              <div className="stack">
                <Button variant="primary" onClick={() => void loadFromSession()} disabled={isLoading}>
                  {isLoading ? 'Refreshing...' : 'Refresh'}
                </Button>
                <Button variant="ghost" onClick={lock}>
                  Lock
                </Button>
              </div>
            </div>
            {error ? <div className="admin-observability__error">{error}</div> : null}
            {snapshot ? (
              <div className="admin-observability__meta mono">
                request_id={snapshot.request_id} generated_at={snapshot.generated_at}
              </div>
            ) : (
              <Button variant="primary" onClick={() => void loadFromSession()} disabled={isLoading}>
                {isLoading ? 'Refreshing...' : 'Refresh'}
              </Button>
            )}
          </CardBody>
        </Card>

        {snapshot ? (
          <>
            <div className="admin-observability__stats-grid">
              <div className="stat-card">
                <div className="stat-card__label">Backend Requests</div>
                <div className="stat-card__value">{snapshot.runtime.backend.total_requests}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">Frontend Runtime Events</div>
                <div className="stat-card__value">{snapshot.runtime.frontend.total_events}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">Persisted Events</div>
                <div className="stat-card__value">{snapshot.persistent.total_events}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">Backend 5xx (5m)</div>
                <div className="stat-card__value" style={{ color: snapshot.persistent.alerts.backend_5xx_last_5m ? 'var(--danger)' : 'var(--success)' }}>
                  {snapshot.persistent.alerts.backend_5xx_last_5m}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">Frontend Errors (5m)</div>
                <div className="stat-card__value" style={{ color: snapshot.persistent.alerts.frontend_errors_last_5m ? 'var(--danger)' : 'var(--success)' }}>
                  {snapshot.persistent.alerts.frontend_errors_last_5m}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">Slow Backend (1h)</div>
                <div className="stat-card__value" style={{ color: snapshot.persistent.alerts.slow_backend_requests_last_1h ? 'var(--warning)' : 'var(--success)' }}>
                  {snapshot.persistent.alerts.slow_backend_requests_last_1h}
                </div>
              </div>
            </div>

            <div className="admin-observability__layout-grid">
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
                        <th>Max</th>
                        <th>Errors</th>
                        <th>Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.runtime.backend.routes.slice(0, 20).map((route) => (
                        <tr key={`${route.method}:${route.path}`}>
                          <td className="mono">{route.method} {route.path}</td>
                          <td>{route.count}</td>
                          <td>{route.avg_duration_ms}ms</td>
                          <td>{route.max_duration_ms}ms</td>
                          <td>{route.errors}</td>
                          <td>{formatRelative(route.last_seen_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardBody>
              </Card>

              <Card>
                <CardHeader>
                  <h2>Source Distribution</h2>
                </CardHeader>
                <CardBody>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th>Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(snapshot.persistent.events_by_source).map(([source, count]) => (
                        <tr key={source}>
                          <td className="mono">{source}</td>
                          <td>{count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardBody>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <h2>Recent Correlated Events</h2>
              </CardHeader>
              <CardBody className="column" style={{ gap: 12 }}>
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search request id, event, path, status, message"
                />
                <div className="admin-observability__event-table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Source</th>
                        <th>Severity</th>
                        <th>Event</th>
                        <th>Route</th>
                        <th>Status</th>
                        <th>Duration</th>
                        <th>Request ID</th>
                        <th>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEvents.slice(0, 100).map((event, idx) => (
                        <tr key={`${event.id ?? event.request_id ?? event.name ?? 'event'}:${idx}`}>
                          <td>{formatRelative(event.created_at)}</td>
                          <td>{event.source ?? '-'}</td>
                          <td><span className={severityClass(event.severity)}>{event.severity ?? 'info'}</span></td>
                          <td className="mono">{event.name ?? event.kind ?? '-'}</td>
                          <td className="mono">{event.method && event.path ? `${event.method} ${event.path}` : event.path ?? '-'}</td>
                          <td>{event.status_code ?? '-'}</td>
                          <td>{typeof event.duration_ms === 'number' ? `${event.duration_ms.toFixed(1)}ms` : '-'}</td>
                          <td className="mono">{event.request_id ?? '-'}</td>
                          <td>{event.message ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardBody>
            </Card>
          </>
        ) : null}
      </div>
    </div>
  )
}
