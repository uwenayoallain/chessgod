import axios from 'axios'

import {
  getCurrentRequestId,
  getTelemetryNowMs,
  reportFrontendEvent,
  setCurrentRequestId,
} from '@/lib/telemetry'

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? '',
})

api.interceptors.request.use((config) => {
  const requestId = crypto.randomUUID()
  config.headers = config.headers ?? {}
  config.headers['X-Request-ID'] = requestId
  const adminPassphrase =
    typeof window !== 'undefined'
      ? window.sessionStorage.getItem('chessgod.observabilityPassphrase')
      : null
  if (
    adminPassphrase &&
    config.url?.includes('/api/health/observability') &&
    !(
      typeof config.headers['X-Admin-Passphrase'] === 'string' &&
      config.headers['X-Admin-Passphrase'].trim()
    )
  ) {
    config.headers['X-Admin-Passphrase'] = adminPassphrase
  }
  ;(config as { metadata?: { startedAtMs: number } }).metadata = {
    startedAtMs: getTelemetryNowMs(),
  }
  return config
})

api.interceptors.response.use(
  (response) => {
    const metadata = (response.config as { metadata?: { startedAtMs: number } }).metadata
    const durationMs = metadata ? getTelemetryNowMs() - metadata.startedAtMs : undefined
    const responseRequestId = response.headers?.['x-request-id']
    if (typeof responseRequestId === 'string') {
      setCurrentRequestId(responseRequestId)
    }
    if (typeof durationMs === 'number' && durationMs > 1200) {
      reportFrontendEvent({
        kind: 'performance',
        name: 'api_slow_request',
        severity: 'warn',
        message: `${response.config.method?.toUpperCase() ?? 'GET'} ${response.config.url ?? ''}`,
        status_code: response.status,
        duration_ms: durationMs,
        request_id:
          typeof responseRequestId === 'string'
            ? responseRequestId
            : (getCurrentRequestId() ?? undefined),
        url: window.location.href,
      })
    }
    return response
  },
  (error) => {
    // A cancelled request is TanStack Query dropping a response nobody needs
    // any more (the board moved on) — not a failure. Reported as one, it made
    // up most of the "failed requests" in the observability panel.
    if (error?.code === 'ERR_CANCELED') return Promise.reject(error)
    const config = error?.config as
      | { url?: string; method?: string; metadata?: { startedAtMs: number } }
      | undefined
    const durationMs = config?.metadata
      ? getTelemetryNowMs() - config.metadata.startedAtMs
      : undefined
    const statusCode =
      typeof error?.response?.status === 'number' ? error.response.status : undefined
    const responseRequestId =
      typeof error?.response?.headers?.['x-request-id'] === 'string'
        ? error.response.headers['x-request-id']
        : (getCurrentRequestId() ?? undefined)

    reportFrontendEvent({
      kind: 'error',
      name: 'api_request_failed',
      severity: statusCode && statusCode < 500 ? 'warn' : 'error',
      message: `${config?.method?.toUpperCase() ?? 'GET'} ${config?.url ?? ''}`,
      status_code: statusCode,
      duration_ms: durationMs,
      request_id: responseRequestId,
      meta: {
        code: typeof error?.code === 'string' ? error.code : 'unknown',
      },
      url: window.location.href,
    })

    return Promise.reject(error)
  },
)
