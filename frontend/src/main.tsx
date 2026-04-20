import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import './index.css'
import { installTelemetryHandlers } from './lib/telemetry'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Root element not found')
}

installTelemetryHandlers()

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
