// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vite-plus/test'

import { RoutesTable } from './routes-table'
import type { ObservabilityRoute } from './types'

function makeRoute(overrides: Partial<ObservabilityRoute> = {}): ObservabilityRoute {
  return {
    method: 'GET',
    path: '/api/health',
    count: 100,
    errors: 1,
    avg_duration_ms: 12.34,
    max_duration_ms: 50.5,
    p50_duration_ms: 11,
    p95_duration_ms: 40,
    p99_duration_ms: 49.9,
    last_status_code: 200,
    last_duration_ms: 11.2,
    last_seen_at: new Date().toISOString(),
    last_query_count: 3,
    max_query_count: 8,
    high_query_count_total: 0,
    status_buckets: { '2xx': 95, '4xx': 4, '5xx': 1 },
    ...overrides,
  }
}

describe('RoutesTable', () => {
  it('renders percentile columns and status mix', () => {
    render(<RoutesTable routes={[makeRoute()]} />)

    expect(screen.getByRole('columnheader', { name: 'p50' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'p95' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'p99' })).toBeTruthy()

    expect(screen.getByText('GET /api/health')).toBeTruthy()
    expect(screen.getByText('11.0ms')).toBeTruthy()
    expect(screen.getByText('40.0ms')).toBeTruthy()
    expect(screen.getByText('49.9ms')).toBeTruthy()

    const bar = document.querySelector('.status-bucket-bar')
    expect(bar).toBeTruthy()
    const segments = bar?.querySelectorAll('.status-bucket-bar__segment') ?? []
    expect(segments.length).toBe(3)
  })

  it('shows N+1 marker when high_query_count_total > 0', () => {
    render(<RoutesTable routes={[makeRoute({ high_query_count_total: 4 })]} />)
    expect(screen.getByText(/N\+1/)).toBeTruthy()
  })

  it('renders empty state when no routes', () => {
    render(<RoutesTable routes={[]} />)
    expect(screen.getByText(/No requests recorded/)).toBeTruthy()
  })
})
