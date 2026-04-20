import { useMemo } from 'react'

import { Header } from '@/components/layout/header'
import { ThemeProvider } from '@/components/layout/theme-provider'
import AdminObservabilityPage from '@/pages/admin-observability'
import Dashboard from '@/pages/dashboard'

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
          {isAdminRoute ? <AdminObservabilityPage /> : <Dashboard />}
        </main>
      </div>
    </ThemeProvider>
  )
}
