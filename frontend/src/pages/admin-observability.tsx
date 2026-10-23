import axios from 'axios'
import { useEffect, useMemo, useState } from 'react'

import { BackgroundTasksPanel } from '@/components/observability/background-tasks-panel'
import { EnginePanel } from '@/components/observability/engine-panel'
import { ExternalCallsTable } from '@/components/observability/external-calls-table'
import { MinuteSparklines } from '@/components/observability/minute-sparklines'
import { QueriesPanel } from '@/components/observability/queries-panel'
import { RoutesTable } from '@/components/observability/routes-table'
import { SlowRequestsTable } from '@/components/observability/slow-requests-table'
import { StatGrid } from '@/components/observability/stat-grid'
import {
  formatRelative,
  severityClass,
  type ObservabilitySnapshot,
} from '@/components/observability/types'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-errors'

const ADMIN_PASSPHRASE_STORAGE_KEY = 'chessgod.observabilityPassphrase'
const EVENT_PAGE_SIZE = 200

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

export default function AdminObservabilityPage() {
  const [passphraseInput, setPassphraseInput] = useState('')
  const [isUnlocked, setIsUnlocked] = useState(() => readStoredPassphrase() != null)
  const [snapshot, setSnapshot] = useState<ObservabilitySnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [eventOffset, setEventOffset] = useState(0)

  const fetchSnapshot = async (passphrase: string, eventsOffset = eventOffset) =>
    api.get<ObservabilitySnapshot>('/api/health/observability', {
      headers: {
        'X-Admin-Passphrase': passphrase,
      },
      params: {
        events_limit: EVENT_PAGE_SIZE,
        events_offset: eventsOffset,
      },
    })

  const unlock = async () => {
    const candidate = passphraseInput.trim()
    if (!candidate) {
      setError('Enter the admin passphrase.')
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const response = await fetchSnapshot(candidate, 0)
      storePassphrase(candidate)
      setIsUnlocked(true)
      setEventOffset(0)
      setPassphraseInput('')
      setSnapshot(response.data)
    } catch (caught) {
      clearStoredPassphrase()
      setIsUnlocked(false)
      setError(getApiErrorMessage(caught, 'Could not load the observability snapshot.'))
      setSnapshot(null)
    } finally {
      setIsLoading(false)
    }
  }

  const loadFromSession = async (eventsOffset = eventOffset) => {
    const stored = readStoredPassphrase()
    if (!stored) {
      setIsUnlocked(false)
      setSnapshot(null)
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const response = await fetchSnapshot(stored, eventsOffset)
      setSnapshot(response.data)
    } catch (caught) {
      const statusCode = axios.isAxiosError(caught) ? caught.response?.status : undefined
      if (statusCode === 401 || statusCode === 403) {
        clearStoredPassphrase()
        setIsUnlocked(false)
        setSnapshot(null)
        setError('Passphrase rejected. Enter it again to unlock the admin page.')
      } else {
        setError(getApiErrorMessage(caught, 'Could not refresh the observability snapshot.'))
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
    setEventOffset(0)
  }

  useEffect(() => {
    if (!isUnlocked) return
    void loadFromSession(eventOffset)
    const timer = window.setInterval(() => void loadFromSession(eventOffset), 10000)
    return () => window.clearInterval(timer)
  }, [isUnlocked, eventOffset])

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

  const eventWindowOffset = snapshot?.persistent.recent_events_offset ?? eventOffset
  const eventWindowSize = snapshot?.persistent.recent_events.length ?? 0
  const eventWindowTotal = snapshot?.persistent.total_events ?? 0
  const hasOlderEvents = eventWindowOffset + eventWindowSize < eventWindowTotal
  const hasNewerEvents = eventWindowOffset > 0
  const pageStart = eventWindowTotal === 0 ? 0 : eventWindowOffset + 1
  const pageEnd = eventWindowOffset + eventWindowSize

  const goToEventOffset = (nextOffset: number) => {
    const clamped = Math.max(0, Math.min(nextOffset, Math.max(0, eventWindowTotal - 1)))
    setSearch('')
    setEventOffset(clamped)
  }

  if (!isUnlocked) {
    return (
      <div className="admin-observability-page admin-observability-page--locked">
        <Card className="admin-observability-lock-card">
          <CardHeader>
            <h2>Observability</h2>
          </CardHeader>
          <CardBody className="column admin-observability__lock-body">
            <label className="column" htmlFor="admin-passphrase" style={{ gap: '8px' }}>
              <span className="muted admin-observability__lock-copy">
                Enter the admin passphrase to unlock observability data.
              </span>
              <Input
                autoComplete="current-password"
                id="admin-passphrase"
                onChange={(event) => setPassphraseInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !isLoading) {
                    void unlock()
                  }
                }}
                placeholder="Enter admin passphrase"
                type="password"
                value={passphraseInput}
              />
            </label>
            <Button
              variant="primary"
              onClick={() => void unlock()}
              disabled={isLoading || passphraseInput.trim().length === 0}
            >
              {isLoading ? 'Unlocking…' : 'Unlock'}
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
            <h2>Observability</h2>
          </CardHeader>
          <CardBody className="column admin-observability__summary-body">
            <div className="stack admin-observability__toolbar">
              <div className="admin-observability__meta">Session unlocked</div>
              <div className="stack">
                <Button
                  variant="primary"
                  onClick={() => void loadFromSession()}
                  disabled={isLoading}
                >
                  {isLoading ? 'Refreshing…' : 'Refresh'}
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
                {isLoading ? 'Refreshing…' : 'Refresh'}
              </Button>
            )}
          </CardBody>
        </Card>

        {snapshot ? (
          <>
            <StatGrid snapshot={snapshot} />

            <Card>
              <CardHeader>
                <h2>Recent activity (last 60 min)</h2>
              </CardHeader>
              <CardBody>
                <MinuteSparklines series={snapshot.runtime.minute_series} />
              </CardBody>
            </Card>

            <RoutesTable routes={snapshot.runtime.backend.routes} />

            <SlowRequestsTable
              rows={snapshot.runtime.backend.slow_requests}
              onSelectRequestId={(requestId) => setSearch(requestId)}
            />

            <QueriesPanel
              templates={snapshot.runtime.queries.templates}
              slow={snapshot.runtime.queries.slow_recent}
            />

            <ExternalCallsTable
              calls={snapshot.runtime.external_calls.calls}
              state={snapshot.runtime.external_calls.state}
            />

            <BackgroundTasksPanel tasks={snapshot.runtime.background_tasks} />

            <EnginePanel metrics={snapshot.runtime.engine} />

            <div className="admin-observability__layout-grid">
              <Card>
                <CardHeader>
                  <h2>Saved events by source</h2>
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
                      {Object.entries(snapshot.persistent.events_by_source).map(
                        ([source, count]) => (
                          <tr key={source}>
                            <td className="mono">{source}</td>
                            <td>{count}</td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </CardBody>
              </Card>

              <Card>
                <CardHeader>
                  <h2>Database pool</h2>
                </CardHeader>
                <CardBody>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Metric</th>
                        <th>Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(snapshot.runtime.system.db_pool).map(([key, value]) => (
                        <tr key={key}>
                          <td className="mono">{key}</td>
                          <td>{String(value)}</td>
                        </tr>
                      ))}
                      {Object.keys(snapshot.runtime.system.db_pool).length === 0 ? (
                        <tr>
                          <td colSpan={2} className="muted">
                            No pool stats sampled yet.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </CardBody>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <h2>Saved events</h2>
              </CardHeader>
              <CardBody className="column admin-observability__summary-body">
                <div className="stack admin-observability__toolbar">
                  <div className="admin-observability__meta">
                    {search.trim()
                      ? `Showing ${filteredEvents.length} matches inside saved events ${pageStart}-${pageEnd} of ${eventWindowTotal}.`
                      : `Showing saved events ${pageStart}-${pageEnd} of ${eventWindowTotal}.`}
                  </div>
                  <div className="stack">
                    <Button
                      variant="ghost"
                      onClick={() =>
                        goToEventOffset(Math.max(0, eventWindowOffset - EVENT_PAGE_SIZE))
                      }
                      disabled={isLoading || !hasNewerEvents}
                    >
                      Newer
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => goToEventOffset(eventWindowOffset + EVENT_PAGE_SIZE)}
                      disabled={isLoading || !hasOlderEvents}
                    >
                      Older
                    </Button>
                  </div>
                </div>
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
                          <td>
                            <span className={severityClass(event.severity)}>
                              {event.severity ?? 'info'}
                            </span>
                          </td>
                          <td className="mono">{event.name ?? event.kind ?? '-'}</td>
                          <td className="mono">
                            {event.method && event.path
                              ? `${event.method} ${event.path}`
                              : (event.path ?? '-')}
                          </td>
                          <td>{event.status_code ?? '-'}</td>
                          <td>
                            {typeof event.duration_ms === 'number'
                              ? `${event.duration_ms.toFixed(1)}ms`
                              : '-'}
                          </td>
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
