// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { StatGrid } from './stat-grid'
import type { ObservabilitySnapshot } from './types'

function makeSnapshot(overrides: Partial<ObservabilitySnapshot> = {}): ObservabilitySnapshot {
  const generatedAt = '2026-04-26T12:00:10.000Z'
  const snapshot: ObservabilitySnapshot = {
    request_id: 'req-1',
    generated_at: generatedAt,
    runtime: {
      uptime_seconds: 60,
      backend: {
        total_requests: 12,
        routes: [],
        recent_errors: [],
        slow_requests: [],
        inflight: 0,
        max_inflight: 1,
      },
      queries: {
        templates: [],
        slow_recent: [],
      },
      external_calls: {
        calls: [],
        state: {},
      },
      minute_series: [],
      background_tasks: [],
      engine: {
        completions: 0,
        errors: 0,
        avg_duration_ms: 0,
        p50_duration_ms: 0,
        p95_duration_ms: 0,
        p99_duration_ms: 0,
        last_depth: null,
        last_nps: null,
        last_queue_depth: null,
        last_multi_pv: null,
        last_seen_at: null,
      },
      system: {
        event_loop_lag_ms: 2.5,
        event_loop_lag_sampled_at: '2026-04-26T12:00:09.000Z',
        process: {
          rss_mb: 128,
          cpu_percent: 8.5,
          sampled_at: '2026-04-26T12:00:08.000Z',
        },
        db_pool: {},
      },
      frontend: {
        total_events: 0,
        events_by_kind: {},
        events_by_severity: {},
        recent_events: [],
      },
    },
    persistent: {
      total_events: 0,
      events_by_source: {},
      alerts: {
        backend_5xx_last_5m: 0,
        frontend_errors_last_5m: 0,
        slow_backend_requests_last_1h: 0,
      },
      recent_events: [],
    },
    ...overrides,
  }
  return snapshot
}

describe('StatGrid', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows sampler freshness for system checks', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-26T12:00:10.000Z'))

    render(<StatGrid snapshot={makeSnapshot()} />)

    expect(screen.getByText('Last sample 1s ago')).toBeTruthy()
    expect(screen.getByText('Sampled 2s ago')).toBeTruthy()
  })
})
