// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { PageBoundary } from './page-boundary'

function Broken(): never {
  throw new Error('Failed to fetch dynamically imported module')
}

describe('PageBoundary', () => {
  afterEach(cleanup)

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
})
