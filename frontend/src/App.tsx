import { lazy, Suspense, useMemo } from 'react'

import { Header } from '@/components/layout/header'
import { ThemeProvider } from '@/components/layout/theme-provider'
import Dashboard from '@/pages/dashboard'

// Operator-only. Loaded on its own route so the board never pays for it.
const AdminObservabilityPage = lazy(() => import('@/pages/admin-observability'))

export default function App() {
  const isAdminRoute = useMemo(() => {
    if (typeof window === 'undefined') {
      return false
    }
    return window.location.pathname === '/admin-observability'
  }, [])

  return (
    <ThemeProvider>
      <div className="app-shell">
        <Header />
        <main className="content">
          {isAdminRoute ? (
            <Suspense fallback={null}>
              <AdminObservabilityPage />
            </Suspense>
          ) : (
            <Dashboard />
          )}
        </main>
      </div>
    </ThemeProvider>
  )
}
