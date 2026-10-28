// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vite-plus/test'

import { useAppStore } from '@/store/app-store'
import { ImportProgress } from './import-progress'

afterEach(() => {
  useAppStore.setState({ importStatus: 'idle', importProgress: null, importQuiet: false })
})

it('shows a sync the player started', () => {
  useAppStore.setState({ importStatus: 'running', importProgress: null, importQuiet: false })
  render(<ImportProgress />)
  expect(screen.getByRole('status').textContent).toContain('Starting import')
})

it('shows nothing for a quiet sync the player did not ask for', () => {
  // A return to the tab syncs in the background; the banner would flash
  // "0 new games" at the player every time otherwise.
  useAppStore.setState({ importStatus: 'running', importProgress: null, importQuiet: true })
  const { container } = render(<ImportProgress />)
  expect(container.firstChild).toBeNull()
})
