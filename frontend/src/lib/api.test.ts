import axios, { AxiosError } from 'axios'
import { beforeEach, expect, it, vi } from 'vite-plus/test'

const { reportFrontendEvent } = vi.hoisted(() => ({ reportFrontendEvent: vi.fn() }))
vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry')>()),
  reportFrontendEvent,
}))

import { api } from './api'

beforeEach(() => {
  vi.stubGlobal('window', {
    location: { href: 'http://localhost/' },
    sessionStorage: { getItem: () => null },
  })
  reportFrontendEvent.mockClear()
})

it('does not report a cancelled request as a failure', async () => {
  await expect(
    api.get('/api/theory/compare', {
      adapter: (config) => Promise.reject(new axios.CanceledError('superseded', undefined, config)),
    }),
  ).rejects.toMatchObject({ code: 'ERR_CANCELED' })
  expect(reportFrontendEvent).not.toHaveBeenCalledWith(
    expect.objectContaining({ name: 'api_request_failed' }),
  )
})

it('still reports a request that really failed', async () => {
  await expect(
    api.get('/api/theory/compare', {
      adapter: (config) =>
        Promise.reject(new AxiosError('boom', 'ERR_BAD_RESPONSE', config, null, undefined)),
    }),
  ).rejects.toBeTruthy()
  expect(reportFrontendEvent).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'api_request_failed' }),
  )
})
