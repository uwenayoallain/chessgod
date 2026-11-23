// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import * as telemetry from '@/lib/telemetry'

import { isStaleBuildError, PageBoundary } from './page-boundary'

function Broken(): never {
  throw new Error('Failed to fetch dynamically imported module')
}

function Buggy(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'lines')")
}

describe('PageBoundary', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps a page that cannot load to its own space and offers a reload', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <div>
        <p>Still here</p>
        <PageBoundary>
          <Broken />
        </PageBoundary>
      </div>,
    )
    expect(screen.getByText('Still here')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('This page did not load')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
    quiet.mockRestore()
  })

  it('renders its children when nothing fails', () => {
    render(
      <PageBoundary>
        <p>Fine</p>
      </PageBoundary>,
    )
    expect(screen.getByText('Fine')).toBeTruthy()
  })

  it('says the app was updated only when a chunk is what failed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(telemetry, 'reportFrontendEvent').mockImplementation(() => undefined)
    render(
      <PageBoundary>
        <Broken />
      </PageBoundary>,
    )
    expect(screen.getByRole('alert').textContent).toContain('The app was updated')
  })

  it('does not blame an update for a bug in the page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(telemetry, 'reportFrontendEvent').mockImplementation(() => undefined)
    render(
      <PageBoundary>
        <Buggy />
      </PageBoundary>,
    )
    const text = screen.getByRole('alert').textContent ?? ''
    expect(text).toContain('This page did not load')
    expect(text).toContain('the error has been reported')
    expect(text).not.toContain('updated')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })

  it('reports a render error with where it happened', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const report = vi.spyOn(telemetry, 'reportFrontendEvent').mockImplementation(() => undefined)
    render(
      <PageBoundary name="dashboard">
        <Buggy />
      </PageBoundary>,
    )
    expect(report).toHaveBeenCalledTimes(1)
    const event = report.mock.calls[0][0]
    expect(event.kind).toBe('error')
    expect(event.name).toBe('page_render_error')
    expect(event.severity).toBe('error')
    expect(event.message).toContain('Cannot read properties of undefined')
    expect(event.stack).toBeTruthy()
    expect(event.meta?.boundary).toBe('dashboard')
    expect(String(event.meta?.component_stack)).toContain('Buggy')
  })

  it('reports a missing chunk as a warning, not an error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const report = vi.spyOn(telemetry, 'reportFrontendEvent').mockImplementation(() => undefined)
    render(
      <PageBoundary>
        <Broken />
      </PageBoundary>,
    )
    expect(report.mock.calls[0][0].name).toBe('page_chunk_missing')
    expect(report.mock.calls[0][0].severity).toBe('warn')
  })

  it('still shows the fallback when reporting itself throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(telemetry, 'reportFrontendEvent').mockImplementation(() => {
      throw new Error('telemetry is down')
    })
    render(
      <PageBoundary>
        <Buggy />
      </PageBoundary>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})

describe('isStaleBuildError', () => {
  it("recognises a chunk that cannot be fetched, in each browser's words", () => {
    expect(isStaleBuildError(new Error('Failed to fetch dynamically imported module: /a.js'))).toBe(
      true,
    )
    expect(isStaleBuildError(new Error('Importing a module script failed.'))).toBe(true)
    expect(isStaleBuildError(new Error('error loading dynamically imported module'))).toBe(true)
  })

  it('does not take an ordinary error for one', () => {
    expect(isStaleBuildError(new TypeError('x is not a function'))).toBe(false)
    expect(isStaleBuildError(undefined)).toBe(false)
  })
})
