import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'

import App from './App'
import './index.css'
import { queryClient } from './lib/query-client'
import { installStaleBuildReload } from './lib/stale-build'
import { installTelemetryHandlers } from './lib/telemetry'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Root element not found')
}

installTelemetryHandlers()
installStaleBuildReload()

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
