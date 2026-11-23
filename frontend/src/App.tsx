import { lazy, Suspense, useMemo } from 'react'

import { PageBoundary } from '@/components/ui/page-boundary'

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
            <PageBoundary name="admin-observability">
              <Suspense fallback={null}>
                <AdminObservabilityPage />
              </Suspense>
            </PageBoundary>
          ) : (
            // The pages inside the dashboard have boundaries of their own;
            // this one is for the workspace around them (the board, the rail,
            // the landing screen). An error there used to unmount everything
            // down to the root and leave a blank page with no way back.
            <PageBoundary name="dashboard">
              <Dashboard />
            </PageBoundary>
          )}
        </main>
      </div>
    </ThemeProvider>
  )
}
