export type StatusBuckets = {
  '2xx'?: number
  '3xx'?: number
  '4xx'?: number
  '5xx'?: number
}

export type ObservabilityRoute = {
  method: string
  path: string
  count: number
  errors: number
  avg_duration_ms: number
  max_duration_ms: number
  p50_duration_ms: number
  p95_duration_ms: number
  p99_duration_ms: number
  last_status_code: number | null
  last_duration_ms: number
  last_seen_at: string | null
  last_query_count?: number
  max_query_count?: number
  high_query_count_total?: number
  status_buckets?: StatusBuckets
}

export type SlowRequest = {
  ts: string
  request_id: string | null
  method: string
  path: string
  status_code: number | null
  duration_ms: number
  query_count?: number
  high_query_count?: boolean
}

export type QueryTemplate = {
  template: string
  count: number
  total_ms: number
  avg_ms: number
  max_ms: number
  p50_ms: number
  p95_ms: number
  p99_ms: number
  last_seen_at: string | null
}

export type SlowQuery = {
  ts: string
  template: string
  duration_ms: number
}

export type ExternalCall = {
  service: string
  operation: string
  count: number
  errors: number
  error_rate: number
  avg_ms: number
  max_ms: number
  p50_ms: number
  p95_ms: number
  p99_ms: number
  last_seen_at: string | null
  last_status_code: number | null
}

export type ExternalState = {
  provider?: string
  cooldown_until?: string | null
  last_status_code?: number | null
  last_error?: string | null
  updated_at?: string | null
}

export type MinuteBucket = {
  minute: string
  requests: number
  errors: number
  p95_ms: number
}

export type BackgroundTask = {
  name: string
  run_count: number
  error_count: number
  last_started_at?: string | null
  last_finished_at?: string | null
  last_duration_ms?: number | null
  last_status?: 'ok' | 'error' | null
  last_error?: string | null
  last_meta?: Record<string, number | string | boolean | null> | null
}

export type EngineMetrics = {
  completions: number
  errors: number
  avg_duration_ms: number
  p50_duration_ms: number
  p95_duration_ms: number
  p99_duration_ms: number
  last_depth: number | null
  last_nps: number | null
  last_queue_depth: number | null
  last_multi_pv: number | null
  last_seen_at: string | null
}

export type ObservabilityEvent = {
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

export type ObservabilitySnapshot = {
  request_id: string
  generated_at: string
  runtime: {
    uptime_seconds: number
    backend: {
      total_requests: number
      routes: ObservabilityRoute[]
      recent_errors: ObservabilityEvent[]
      slow_requests: SlowRequest[]
      inflight: number
      max_inflight: number
    }
    queries: {
      templates: QueryTemplate[]
      slow_recent: SlowQuery[]
    }
    external_calls: {
      calls: ExternalCall[]
      state: Record<string, ExternalState>
    }
    minute_series: MinuteBucket[]
    background_tasks: BackgroundTask[]
    engine: EngineMetrics
    system: {
      event_loop_lag_ms: number | null
      event_loop_lag_sampled_at?: string | null
      process: {
        rss_mb: number | null
        cpu_percent: number | null
        sampled_at: string | null
      }
      db_pool: Record<string, number | string>
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
    recent_events_limit?: number
    recent_events_offset?: number
    events_by_source: Record<string, number>
    alerts: {
      backend_5xx_last_5m: number
      frontend_errors_last_5m: number
      slow_backend_requests_last_1h: number
    }
    recent_events: ObservabilityEvent[]
  }
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'n/a'
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return iso
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`
  return `${Math.floor(deltaSeconds / 3600)}h ago`
}

export function severityClass(severity: string | null | undefined): string {
  if (severity === 'error')
    return 'admin-observability__severity admin-observability__severity--error'
  if (severity === 'warn')
    return 'admin-observability__severity admin-observability__severity--warn'
  return 'admin-observability__severity'
}

export function formatNumber(value: number | null | undefined, suffix = ''): string {
  if (value == null || Number.isNaN(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M${suffix}`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k${suffix}`
  return `${value}${suffix}`
}
